
from contextlib import asynccontextmanager
import shutil
import tempfile
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath
from uuid import uuid4
import json
from pydantic import BaseModel, Field

import geopandas as gpd
import pyogrio
from shapely.geometry import MultiPoint, MultiLineString, MultiPolygon
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import models, schemas
from .database import Base, engine, get_db


MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_ZIP_MEMBERS = 2000
MAX_UNCOMPRESSED_ZIP_BYTES = MAX_UPLOAD_BYTES * 5
MAX_FEATURES = 2_000_000


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Inicialización para desarrollo. En producción se recomienda Alembic.
    Base.metadata.create_all(bind=engine)

    # Cambio aditivo: conserva las filas y añade la columna si falta.
    with engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE datasets "
                "ADD COLUMN IF NOT EXISTS storage_table VARCHAR(63)"
            )
        )
        # Tabla independiente para guardar composiciones de mapas.
        # Borrar una composición nunca elimina datasets ni tablas espaciales.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS map_configurations (
                id BIGSERIAL PRIMARY KEY,
                project_id INTEGER NOT NULL
                    REFERENCES projects(id) ON DELETE CASCADE,
                name VARCHAR(180) NOT NULL,
                description TEXT,
                configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS ix_map_configurations_project_id
            ON map_configurations(project_id)
        """))

    yield


app = FastAPI(
    title="GIS & Data Platform API",
    version="0.3.0",
    description="Local-first API for GIS projects and data engineering workflows.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# ---------------------------------------------------------
# HEALTH CHECKS
# ---------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "environment": "local"}


@app.get("/health/database")
def database_health(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
        postgis = db.execute(
            text("SELECT PostGIS_Full_Version()")
        ).scalar_one()

        return {
            "status": "ok",
            "postgis": postgis,
        }
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Database or PostGIS unavailable",
        ) from exc


# ---------------------------------------------------------
# ORGANIZATIONS
# ---------------------------------------------------------

@app.get(
    "/api/v1/organizations",
    response_model=list[schemas.OrganizationRead],
)
def list_organizations(db: Session = Depends(get_db)):
    return (
        db.query(models.Organization)
        .order_by(models.Organization.name)
        .all()
    )


@app.post(
    "/api/v1/organizations",
    response_model=schemas.OrganizationRead,
    status_code=201,
)
def create_organization(
    payload: schemas.OrganizationCreate,
    db: Session = Depends(get_db),
):
    item = models.Organization(
        name=payload.name.strip(),
        slug=payload.slug,
    )

    db.add(item)

    try:
        db.commit()
        db.refresh(item)
        return item
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Organization name or slug already exists",
        ) from exc


# ---------------------------------------------------------
# PROJECTS
# ---------------------------------------------------------

@app.get(
    "/api/v1/projects",
    response_model=list[schemas.ProjectRead],
)
def list_projects(
    organization_id: int | None = Query(default=None, gt=0),
    db: Session = Depends(get_db),
):
    query = db.query(models.Project)

    if organization_id is not None:
        query = query.filter(
            models.Project.organization_id == organization_id
        )

    return query.order_by(
        models.Project.created_at.desc()
    ).all()


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=180)
    description: str | None = None
    project_type: str | None = Field(default=None, pattern="^(gis|etl|integration|application)$")
    status: str | None = Field(default=None, max_length=30)


@app.patch("/api/v1/projects/{project_id}", response_model=schemas.ProjectRead)
def update_project(
    project_id: int,
    payload: ProjectUpdate,
    db: Session = Depends(get_db),
):
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    values = payload.model_dump(exclude_unset=True)
    for key, value in values.items():
        if isinstance(value, str):
            value = value.strip()
        setattr(project, key, value or None if key == "description" else value)
    db.commit()
    db.refresh(project)
    return project


@app.post(
    "/api/v1/projects",
    response_model=schemas.ProjectRead,
    status_code=201,
)
def create_project(
    payload: schemas.ProjectCreate,
    db: Session = Depends(get_db),
):
    organization = db.get(
        models.Organization,
        payload.organization_id,
    )

    if organization is None:
        raise HTTPException(
            status_code=404,
            detail="Organization not found",
        )

    item = models.Project(
        organization_id=payload.organization_id,
        name=payload.name.strip(),
        description=payload.description,
        project_type=payload.project_type,
    )

    db.add(item)
    db.commit()
    db.refresh(item)

    return item


# ---------------------------------------------------------
# DATASET CATALOG
# ---------------------------------------------------------

@app.get(
    "/api/v1/datasets",
    response_model=list[schemas.DatasetRead],
)
def list_datasets(
    project_id: int | None = Query(default=None, gt=0),
    db: Session = Depends(get_db),
):
    query = db.query(models.Dataset)

    if project_id is not None:
        query = query.filter(
            models.Dataset.project_id == project_id
        )

    return query.order_by(
        models.Dataset.created_at.desc()
    ).all()


@app.post(
    "/api/v1/datasets",
    response_model=schemas.DatasetRead,
    status_code=201,
)
def create_dataset(
    payload: schemas.DatasetCreate,
    db: Session = Depends(get_db),
):
    project = db.get(models.Project, payload.project_id)

    if project is None:
        raise HTTPException(
            status_code=404,
            detail="Project not found",
        )

    item = models.Dataset(
        project_id=payload.project_id,
        name=payload.name.strip(),
        description=(
            payload.description.strip()
            if payload.description
            else None
        ),
        source_format=payload.source_format,
        source_filename=payload.source_filename,
        geometry_type=payload.geometry_type,
        crs=payload.crs.strip() if payload.crs else None,
        status="registered",
    )

    db.add(item)
    db.commit()
    db.refresh(item)

    return item


# ---------------------------------------------------------
# DATASET FEATURES (GeoJSON)
# ---------------------------------------------------------

@app.get("/api/v1/datasets/{dataset_id}/features")
def get_dataset_features(
    dataset_id: int,
    limit: int = Query(default=1000, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    """Devuelve entidades de un dataset PostGIS como GeoJSON en EPSG:4326."""

    dataset = db.get(models.Dataset, dataset_id)

    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset no encontrado")

    if dataset.status != "ready" or not dataset.storage_table:
        raise HTTPException(
            status_code=409,
            detail="El dataset no está disponible para consulta espacial",
        )

    # Las tablas las genera el servidor; aun así, validar antes de interpolar
    # un identificador SQL (los parámetros SQL no sirven para nombres de tabla).
    import re

    if not re.fullmatch(r"dataset_[0-9a-f]{20}", dataset.storage_table):
        raise HTTPException(
            status_code=500,
            detail="El identificador de almacenamiento del dataset no es válido",
        )

    table_name = dataset.storage_table

    try:
        with engine.connect() as conn:
            # Descubrir la columna geométrica real y su SRID.
            geometry_columns = conn.execute(
                text("""
                    SELECT f_geometry_column, srid
                    FROM public.geometry_columns
                    WHERE f_table_schema = 'public'
                      AND f_table_name = :table_name
                """),
                {"table_name": table_name},
            ).all()

            if not geometry_columns:
                raise HTTPException(
                    status_code=500,
                    detail="No se ha encontrado una columna geométrica para este dataset",
                )

            geometry_column, _source_srid = geometry_columns[0]

            # Los nombres de columna se escapan como identificadores SQL.
            # El nombre proviene del catálogo geometry_columns, no del usuario.
            safe_geometry_column = '"' + geometry_column.replace('"', '""') + '"'
            safe_table_name = '"' + table_name.replace('"', '""') + '"'

            rows = conn.execute(
                text(f"""
                    SELECT
                        ST_AsGeoJSON(
                            ST_Transform({safe_geometry_column}, 4326)
                        ) AS geometry_json,
                        (
                            to_jsonb(source_row)
                            - :geometry_column
                        ) AS properties
                    FROM public.{safe_table_name} AS source_row
                    WHERE {safe_geometry_column} IS NOT NULL
                    ORDER BY ctid
                    LIMIT :limit OFFSET :offset
                """),
                {
                    "geometry_column": geometry_column,
                    "limit": limit,
                    "offset": offset,
                },
            ).all()

            total = conn.execute(
                text(f"""
                    SELECT COUNT(*)
                    FROM public.{safe_table_name}
                    WHERE {safe_geometry_column} IS NOT NULL
                """)
            ).scalar_one()

        import json

        features = []
        for geometry_json, properties in rows:
            features.append({
                "type": "Feature",
                "geometry": json.loads(geometry_json) if geometry_json else None,
                "properties": properties or {},
            })

        return {
            "type": "FeatureCollection",
            "dataset_id": dataset.id,
            "dataset_name": dataset.name,
            "crs": "EPSG:4326",
            "total_features": total,
            "limit": limit,
            "offset": offset,
            "features": features,
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="No se pudieron consultar las entidades espaciales del dataset",
        ) from exc


# ---------------------------------------------------------
# SHAPEFILE ZIP EXTRACTION
# ---------------------------------------------------------

def _extract_shapefile_zip(
    zip_path: Path,
    destination: Path,
) -> Path:
    """Extrae de forma controlada un ZIP con un único Shapefile."""

    destination.mkdir(parents=True, exist_ok=True)

    try:
        with zipfile.ZipFile(zip_path) as archive:
            members = archive.infolist()

            if len(members) > MAX_ZIP_MEMBERS:
                raise HTTPException(
                    status_code=413,
                    detail="El ZIP contiene demasiados archivos",
                )

            uncompressed_size = sum(
                member.file_size for member in members
            )

            if uncompressed_size > MAX_UNCOMPRESSED_ZIP_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail="El contenido descomprimido del ZIP es demasiado grande",
                )

            # Evitar rutas absolutas y ataques de traversal.
            for member in members:
                posix_path = PurePosixPath(member.filename)
                windows_path = PureWindowsPath(member.filename)

                if (
                    posix_path.is_absolute()
                    or windows_path.is_absolute()
                    or ".." in posix_path.parts
                    or ".." in windows_path.parts
                    or windows_path.drive
                ):
                    raise HTTPException(
                        status_code=400,
                        detail="Ruta no permitida dentro del ZIP",
                    )

            archive.extractall(destination)

    except zipfile.BadZipFile as exc:
        raise HTTPException(
            status_code=400,
            detail="El ZIP no es válido",
        ) from exc

    shapefiles = [
        path
        for path in destination.rglob("*")
        if path.is_file()
        and path.suffix.lower() == ".shp"
    ]

    if len(shapefiles) != 1:
        raise HTTPException(
            status_code=400,
            detail="El ZIP debe contener exactamente un archivo .shp",
        )

    shapefile = shapefiles[0]

    sibling_extensions = {
        path.suffix.lower()
        for path in shapefile.parent.iterdir()
        if path.is_file()
        and path.stem.lower() == shapefile.stem.lower()
    }

    required_extensions = {".shp", ".shx", ".dbf"}

    if not required_extensions.issubset(sibling_extensions):
        raise HTTPException(
            status_code=400,
            detail="El Shapefile necesita archivos .shp, .shx y .dbf coincidentes",
        )

    return shapefile


# ---------------------------------------------------------
# GIS FILE READING AND VALIDATION
# ---------------------------------------------------------

def _read_and_validate_gis(
    path: Path,
    file_format: str,
) -> gpd.GeoDataFrame:
    """Lee, valida y normaliza las geometrías de un archivo GIS."""

    try:
        if file_format == "shapefile":
            source_path = _extract_shapefile_zip(
                path,
                path.parent / "extracted",
            )
            gdf = pyogrio.read_dataframe(source_path)

        elif file_format == "geojson":
            gdf = pyogrio.read_dataframe(path)

        elif file_format == "geopackage":
            layers = pyogrio.list_layers(path)

            if len(layers) == 0:
                raise HTTPException(
                    status_code=400,
                    detail="El GeoPackage no contiene capas",
                )

            # Esta versión importa la primera capa del GeoPackage.
            gdf = pyogrio.read_dataframe(
                path,
                layer=str(layers[0][0]),
            )

        else:
            raise HTTPException(
                status_code=400,
                detail="Formato GIS no compatible",
            )

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="No se pudo leer el archivo GIS. Comprueba su formato e integridad.",
        ) from exc

    if gdf.empty:
        raise HTTPException(
            status_code=400,
            detail="El dataset no contiene entidades",
        )

    if gdf.crs is None:
        raise HTTPException(
            status_code=400,
            detail="El dataset no tiene CRS definido. Asígnalo antes de importarlo.",
        )

    if gdf.geometry.isna().any():
        raise HTTPException(
            status_code=400,
            detail="Hay geometrías nulas",
        )

    if (~gdf.geometry.is_valid).any():
        raise HTTPException(
            status_code=400,
            detail="Hay geometrías no válidas",
        )

    if len(gdf) > MAX_FEATURES:
        raise HTTPException(
            status_code=413,
            detail="El dataset supera los dos millones de entidades",
        )

    geometry_types = set(
        gdf.geometry.geom_type.dropna().tolist()
    )

    if not geometry_types:
        raise HTTPException(
            status_code=400,
            detail="No se han encontrado geometrías válidas",
        )

    # Aceptar geometrías simples y múltiples de una misma familia.
    families = set()

    for geometry_type in geometry_types:
        if geometry_type in {"Point", "MultiPoint"}:
            families.add("point")

        elif geometry_type in {"LineString", "MultiLineString"}:
            families.add("line")

        elif geometry_type in {"Polygon", "MultiPolygon"}:
            families.add("polygon")

        else:
            raise HTTPException(
                status_code=400,
                detail=f"Tipo de geometría no compatible: {geometry_type}",
            )

    # No permitir, por ejemplo, puntos y polígonos en una misma tabla.
    if len(families) != 1:
        raise HTTPException(
            status_code=400,
            detail=(
                "El dataset mezcla familias geométricas incompatibles: "
                f"{sorted(geometry_types)}"
            ),
        )

    family = next(iter(families))

    # Normalizar a geometrías múltiples para evitar el conflicto
    # Polygon/MultiPolygon, LineString/MultiLineString o Point/MultiPoint.
    if family == "polygon":
        gdf.geometry = gdf.geometry.apply(
            lambda geom: (
                MultiPolygon([geom])
                if geom is not None and geom.geom_type == "Polygon"
                else geom
            )
        )

    elif family == "line":
        gdf.geometry = gdf.geometry.apply(
            lambda geom: (
                MultiLineString([geom])
                if geom is not None and geom.geom_type == "LineString"
                else geom
            )
        )

    elif family == "point":
        gdf.geometry = gdf.geometry.apply(
            lambda geom: (
                MultiPoint([geom])
                if geom is not None and geom.geom_type == "Point"
                else geom
            )
        )

    return gdf


# ---------------------------------------------------------
# GIS FILE UPLOAD AND POSTGIS IMPORT
# ---------------------------------------------------------

@app.post(
    "/api/v1/datasets/upload",
    status_code=201,
)
async def upload_dataset(
    project_id: int = Form(..., gt=0),
    name: str = Form(..., min_length=2, max_length=180),
    description: str | None = Form(default=None, max_length=5000),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Importa un archivo GIS en una tabla espacial propia de PostGIS."""

    project = db.get(models.Project, project_id)

    if project is None:
        raise HTTPException(
            status_code=404,
            detail="Proyecto no encontrado",
        )

    original_filename = Path(file.filename or "").name
    suffix = Path(original_filename).suffix.lower()

    if suffix == ".zip":
        file_format = "shapefile"

    elif suffix in {".geojson", ".json"}:
        file_format = "geojson"

    elif suffix == ".gpkg":
        file_format = "geopackage"

    else:
        raise HTTPException(
            status_code=400,
            detail="Formatos admitidos: ZIP Shapefile, GeoJSON y GeoPackage",
        )

    temp_dir = Path(
        tempfile.mkdtemp(prefix="spatialworks_")
    )
    upload_path = temp_dir / ("source" + suffix)

    # Identificador generado por el servidor, no por el nombre del archivo.
    storage_table = "dataset_" + uuid4().hex[:20]
    table_created = False

    try:
        size = 0

        with upload_path.open("wb") as output:
            while True:
                chunk = await file.read(1024 * 1024)

                if not chunk:
                    break

                size += len(chunk)

                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="El archivo supera los 100 MiB",
                    )

                output.write(chunk)

        if size == 0:
            raise HTTPException(
                status_code=400,
                detail="El archivo está vacío",
            )

        gdf = _read_and_validate_gis(
            upload_path,
            file_format,
        )

        geometry_type = str(
            gdf.geometry.geom_type.iloc[0]
        )
        crs_text = gdf.crs.to_string()

        # Importación real de las geometrías y atributos a PostGIS.
        gdf.to_postgis(
            name=storage_table,
            con=engine,
            schema="public",
            if_exists="fail",
            index=False,
            chunksize=5000,
        )

        table_created = True

        # Registrar metadatos una vez completada la escritura espacial.
        dataset = models.Dataset(
            project_id=project_id,
            name=name.strip(),
            description=(
                description.strip()
                if description
                else None
            ),
            source_format=file_format,
            source_filename=original_filename[:255],
            geometry_type=geometry_type,
            crs=crs_text[:40],
            feature_count=int(len(gdf)),
            status="ready",
            storage_table=storage_table,
        )

        db.add(dataset)
        db.commit()
        db.refresh(dataset)

        return {
            "id": dataset.id,
            "project_id": dataset.project_id,
            "name": dataset.name,
            "source_format": dataset.source_format,
            "source_filename": dataset.source_filename,
            "geometry_type": dataset.geometry_type,
            "crs": dataset.crs,
            "feature_count": dataset.feature_count,
            "status": dataset.status,
            "storage_table": dataset.storage_table,
        }

    except HTTPException:
        db.rollback()
        raise

    except Exception as exc:
        db.rollback()

        # Si falla el registro, intentar retirar la tabla recién creada.
        # El nombre contiene solo el prefijo fijo y caracteres hexadecimales.
        if table_created:
            try:
                with engine.begin() as conn:
                    conn.execute(
                        text(
                            f'DROP TABLE IF EXISTS public."{storage_table}"'
                        )
                    )
            except Exception:
                pass

        raise HTTPException(
            status_code=500,
            detail="Error durante la importación del dataset",
        ) from exc

    finally:
        await file.close()
        shutil.rmtree(
            temp_dir,
            ignore_errors=True,
        )


# ---------------------------------------------------------
# SAVED MAP CONFIGURATIONS
# ---------------------------------------------------------

class MapConfigurationCreate(BaseModel):
    name: str = Field(min_length=2, max_length=180)
    description: str | None = Field(default=None, max_length=5000)
    configuration: dict = Field(default_factory=dict)


class MapConfigurationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=180)
    description: str | None = Field(default=None, max_length=5000)
    configuration: dict | None = None


def _map_configuration_dict(row):
    item = dict(row)
    # PostgreSQL/SQLAlchemy normally decodes JSONB into a dict; keep
    # compatibility with drivers returning serialized JSON.
    if isinstance(item.get("configuration"), str):
        item["configuration"] = json.loads(item["configuration"])
    return item


@app.get("/api/v1/projects/{project_id}/maps")
def list_project_maps(project_id: int, db: Session = Depends(get_db)):
    if db.get(models.Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    rows = db.execute(
        text("""
            SELECT id, project_id, name, description, configuration,
                   created_at, updated_at
            FROM map_configurations
            WHERE project_id = :project_id
            ORDER BY updated_at DESC, id DESC
        """),
        {"project_id": project_id},
    ).mappings().all()
    return [_map_configuration_dict(row) for row in rows]


@app.post("/api/v1/projects/{project_id}/maps", status_code=201)
def create_project_map(
    project_id: int,
    payload: MapConfigurationCreate,
    db: Session = Depends(get_db),
):
    if db.get(models.Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    name = payload.name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=422, detail="El nombre debe tener al menos 2 caracteres")
    row = db.execute(
        text("""
            INSERT INTO map_configurations
                (project_id, name, description, configuration)
            VALUES
                (:project_id, :name, :description, CAST(:configuration AS jsonb))
            RETURNING id, project_id, name, description, configuration,
                      created_at, updated_at
        """),
        {
            "project_id": project_id,
            "name": name,
            "description": payload.description.strip() if payload.description else None,
            "configuration": json.dumps(payload.configuration),
        },
    ).mappings().one()
    db.commit()
    return _map_configuration_dict(row)


@app.get("/api/v1/maps/{map_id}")
def get_saved_map(map_id: int, db: Session = Depends(get_db)):
    row = db.execute(
        text("""
            SELECT id, project_id, name, description, configuration,
                   created_at, updated_at
            FROM map_configurations
            WHERE id = :map_id
        """),
        {"map_id": map_id},
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Mapa guardado no encontrado")
    return _map_configuration_dict(row)


@app.patch("/api/v1/maps/{map_id}")
def update_saved_map(
    map_id: int,
    payload: MapConfigurationUpdate,
    db: Session = Depends(get_db),
):
    current = db.execute(
        text("SELECT id FROM map_configurations WHERE id = :map_id"),
        {"map_id": map_id},
    ).first()
    if current is None:
        raise HTTPException(status_code=404, detail="Mapa guardado no encontrado")

    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        return get_saved_map(map_id, db)

    assignments = ["updated_at = CURRENT_TIMESTAMP"]
    params = {"map_id": map_id}
    if "name" in changes and changes["name"] is not None:
        name = changes["name"].strip()
        if len(name) < 2:
            raise HTTPException(status_code=422, detail="El nombre debe tener al menos 2 caracteres")
        assignments.append("name = :name")
        params["name"] = name
    if "description" in changes:
        assignments.append("description = :description")
        params["description"] = changes["description"].strip() if changes["description"] else None
    if "configuration" in changes and changes["configuration"] is not None:
        assignments.append("configuration = CAST(:configuration AS jsonb)")
        params["configuration"] = json.dumps(changes["configuration"])

    db.execute(
        text(f"""
            UPDATE map_configurations
            SET {", ".join(assignments)}
            WHERE id = :map_id
        """),
        params,
    )
    db.commit()
    return get_saved_map(map_id, db)


@app.delete("/api/v1/maps/{map_id}", status_code=204)
def delete_saved_map(map_id: int, db: Session = Depends(get_db)):
    result = db.execute(
        text("DELETE FROM map_configurations WHERE id = :map_id"),
        {"map_id": map_id},
    )
    if result.rowcount == 0:
        db.rollback()
        raise HTTPException(status_code=404, detail="Mapa guardado no encontrado")
    db.commit()
    # Only the map configuration row is deleted; datasets are untouched.
    return None

