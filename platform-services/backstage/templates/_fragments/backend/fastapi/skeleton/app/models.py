# models.py — SQLAlchemy 2.x ORM models (typed `Mapped[...]` style).
#
# `Item` is a sample model so the CRUD router has something to persist. Replace it
# with your own domain models. String columns are LENGTH-BOUNDED because MySQL
# requires an explicit length on VARCHAR (unlike SQLite) — keep lengths on every
# String column or the MySQL DDL will fail.
from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class Item(Base):
    __tablename__ = "items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(1024), nullable=True)
