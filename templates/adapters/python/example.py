from __future__ import annotations

import asyncio

from aegis_adapter_template.twilio_simulated import SimulatedTwilioAdapter
from aegis_adapter_template.types import ActionContext


async def main() -> None:
    adapter = SimulatedTwilioAdapter()

    await adapter.connect(
        {
            "account_sid": "ACXXXX",
            "auth_token_ref": "TWILIO_AUTH_TOKEN",
            "from_phone": "+15550001111",
        }
    )

    payload = {
        "to_phone": "+15550002222",
        "message": "Route update: pickup moved to Dock 4.",
        "route_id": "route-2026-02-12-001",
    }

    context = ActionContext(
        tenant_id="tenant-a",
        correlation_id="corr-123",
        actor_id="agent-dispatcher",
        mode="sandbox",
    )

    simulation = await adapter.simulate(payload, context)
    execution = await adapter.execute(payload, context)

    print({"simulation": simulation, "execution": execution})


if __name__ == "__main__":
    asyncio.run(main())
