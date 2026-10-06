import httpx
from app.services.usage import record_usage


def validate_args(name: str, args: dict) -> dict:
    if not isinstance(args, dict):
        raise ValueError(name)
    return args


def format_result(result) -> dict:
    return {"ok": True, "result": result}


async def run_tool(name: str, args: dict) -> dict:
    """Every tool goes through here: validate, call the tool service, record usage, format."""
    clean = validate_args(name, args)
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"http://tools-service/run/{name}", json=clean)
    await record_usage(name)
    return format_result(resp.json())
