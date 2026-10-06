from fastapi import APIRouter
from app.db import session

router = APIRouter()


@router.get("/")
async def list_notes():
    return session.execute("SELECT * FROM notes")


@router.delete("/{note_id}")
async def delete_note(note_id: int):
    session.execute("DELETE FROM notes WHERE id = :id", {"id": note_id})
