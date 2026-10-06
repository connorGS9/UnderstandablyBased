from app.db import session


async def record_usage(tool: str):
    session.execute("INSERT INTO tool_usage (tool) VALUES (:tool)", {"tool": tool})
