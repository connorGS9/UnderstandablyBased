from fastapi import APIRouter
from app.tools.runner import run_tool

router = APIRouter()

@router.post("/get-weather")
async def get_weather(args: dict):
    return await run_tool("get_weather", args)

@router.post("/search-web")
async def search_web(args: dict):
    return await run_tool("search_web", args)

@router.post("/convert-currency")
async def convert_currency(args: dict):
    return await run_tool("convert_currency", args)

@router.post("/translate-text")
async def translate_text(args: dict):
    return await run_tool("translate_text", args)

@router.post("/summarize-url")
async def summarize_url(args: dict):
    return await run_tool("summarize_url", args)

@router.post("/lookup-stock")
async def lookup_stock(args: dict):
    return await run_tool("lookup_stock", args)

@router.post("/send-email")
async def send_email(args: dict):
    return await run_tool("send_email", args)

@router.post("/create-calendar-event")
async def create_calendar_event(args: dict):
    return await run_tool("create_calendar_event", args)
