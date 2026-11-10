from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ProjectCreate(BaseModel):
    organization_id: int = Field(gt=0)
    name: str = Field(min_length=2, max_length=180)
    description: str | None = None
    project_type: str = Field(
        default="gis", pattern="^(gis|etl|integration|application)$"
    )


class ProjectRead(BaseModel):
    id: int
    organization_id: int
    name: str
    description: str | None
    project_type: str
    status: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class OrganizationCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    slug: str = Field(min_length=2, max_length=180, pattern="^[a-z0-9-]+$")


class OrganizationRead(BaseModel):
    id: int
    name: str
    slug: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DatasetCreate(BaseModel):
    project_id: int = Field(gt=0)
    name: str = Field(min_length=2, max_length=180)
    description: str | None = Field(default=None, max_length=5000)
    source_format: str = Field(pattern="^(shapefile|geojson|geopackage)$")
    source_filename: str | None = Field(default=None, max_length=255)
    geometry_type: str | None = Field(
        default=None,
        pattern="^(Point|MultiPoint|LineString|MultiLineString|Polygon|MultiPolygon|GeometryCollection|Unknown)$",
    )
    crs: str | None = Field(default=None, max_length=40)


class DatasetRead(BaseModel):
    id: int
    project_id: int
    name: str
    description: str | None
    source_format: str
    source_filename: str | None
    geometry_type: str | None
    crs: str | None
    feature_count: int | None
    status: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
