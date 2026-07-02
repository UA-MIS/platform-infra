# items.py — a sample CRUD router over the `Item` model. This is the pattern to copy
# for your own resources: a router, the `get_db` session dependency, SQLAlchemy 2.x
# `select()` queries, and Pydantic schemas for the request/response contract.
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Item
from ..schemas import ItemCreate, ItemRead, ItemUpdate

router = APIRouter(prefix="/items", tags=["items"])


@router.post("", response_model=ItemRead, status_code=status.HTTP_201_CREATED)
def create_item(payload: ItemCreate, db: Session = Depends(get_db)) -> Item:
    item = Item(name=payload.name, description=payload.description)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("", response_model=list[ItemRead])
def list_items(db: Session = Depends(get_db)) -> list[Item]:
    return list(db.scalars(select(Item).order_by(Item.id)).all())


@router.get("/{item_id}", response_model=ItemRead)
def get_item(item_id: int, db: Session = Depends(get_db)) -> Item:
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found")
    return item


@router.put("/{item_id}", response_model=ItemRead)
def update_item(item_id: int, payload: ItemUpdate, db: Session = Depends(get_db)) -> Item:
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found")
    # Only overwrite fields the caller actually sent (PATCH-like semantics).
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(item_id: int, db: Session = Depends(get_db)) -> None:
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found")
    db.delete(item)
    db.commit()
