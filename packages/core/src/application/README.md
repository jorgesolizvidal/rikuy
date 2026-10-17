# application

Use cases. Each one receives an explicit `TenantContext`/`ActorContext`, validates input,
authorizes the action and talks to repositories through ports (interfaces).
The same use case serves the admin UI, the public portal, the worker and the AI Copilot.
