from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from app.db import session

router = APIRouter()
client = AsyncOpenAI()


def load_history(conversation_id: int):
    return session.execute("SELECT * FROM messages WHERE conversation_id = :id", {"id": conversation_id})


def save_message(conversation_id: int, text: str):
    session.execute("INSERT INTO messages (conversation_id, text) VALUES (:id, :t)", {"id": conversation_id, "t": text})


async def generate(conversation_id: int, prompt: str):
    history = load_history(conversation_id)
    stream = await client.chat.completions.create(model="gpt-4o", messages=history, stream=True)
    async for chunk in stream:
        yield chunk


@router.post("/{conversation_id}/messages")
async def send_message(conversation_id: int, prompt: str):
    save_message(conversation_id, prompt)
    return StreamingResponse(generate(conversation_id, prompt), media_type="text/event-stream")


@router.get("/{conversation_id}")
async def get_conversation(conversation_id: int):
    return load_history(conversation_id)
