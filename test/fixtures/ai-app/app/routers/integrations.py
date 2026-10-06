from fastapi import APIRouter
from app.integrations import slack, github, jira, notion, linear

router = APIRouter()

@router.post("/slack/sync")
async def sync_slack_route(payload: dict):
    return {"synced": slack.sync_slack(payload)}

@router.post("/github/sync")
async def sync_github_route(payload: dict):
    return {"synced": github.sync_github(payload)}

@router.post("/jira/sync")
async def sync_jira_route(payload: dict):
    return {"synced": jira.sync_jira(payload)}

@router.post("/notion/sync")
async def sync_notion_route(payload: dict):
    return {"synced": notion.sync_notion(payload)}

@router.post("/linear/sync")
async def sync_linear_route(payload: dict):
    return {"synced": linear.sync_linear(payload)}
