from app.db import session


def sync_notion(payload: dict):
    items = payload.get("items", [])
    session.execute("INSERT INTO notion_items (data) VALUES (:d)", {"d": items})
    return len(items)
