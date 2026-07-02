# schemas.py — Pydantic v2 request/response models (the API contract), kept separate
# from the ORM models so the wire shape and the table shape can evolve independently.
from pydantic import BaseModel, ConfigDict, Field


class ItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1024)


class ItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1024)


class ItemRead(BaseModel):
    # from_attributes lets FastAPI serialize an ORM `Item` instance straight to JSON.
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None = None
