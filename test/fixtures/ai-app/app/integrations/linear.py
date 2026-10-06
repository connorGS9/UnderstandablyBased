from app.db import session


def sync_linear(payload: dict):
    items = payload.get("items", [])
    session.execute("INSERT INTO linear_items (data) VALUES (:d)", {"d": items})
    return len(items)
