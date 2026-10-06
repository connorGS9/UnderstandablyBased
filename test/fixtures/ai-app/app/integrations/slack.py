from app.db import session


def sync_slack(payload: dict):
    items = payload.get("items", [])
    session.execute("INSERT INTO slack_items (data) VALUES (:d)", {"d": items})
    return len(items)
