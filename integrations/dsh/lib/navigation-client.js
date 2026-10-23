window.__ModuleLoader__.load({
  id: "@island-hud/dsh-bridge",
  factory: () => {
    // Filled in by the integration manager from the local navigation descriptor
    // (random per-install token and the port the island actually listens on).
    const endpoint = "__ISLAND_HUD_NAV_ENDPOINT__";
    return {
      name: "island-hud-session-navigation",
      inject: ["uiWorkspace", "sessions"],
      apply(ctx) {
        let disposed = false;
        let timer = null;
        let active = false;
        const ack = async (requestId, status) => {
          try {
            await fetch(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ requestId, status }),
              cache: "no-store",
            });
          } catch { /* The island will expire the navigation request. */ }
        };
        const poll = async () => {
          if (disposed || active) return;
          active = true;
          try {
            const response = await fetch(endpoint, { cache: "no-store" });
            if (response.status === 200) {
              const request = await response.json();
              if (request?.protocol === 1 && typeof request.requestId === "string" && typeof request.sessionId === "string") {
                const known = ctx.sessions.list.getSnapshot().byId[request.sessionId];
                if (!known) {
                  await ack(request.requestId, "expired");
                } else {
                  try {
                    ctx.uiWorkspace.openSession(request.sessionId);
                    await ack(request.requestId, "navigated");
                  } catch {
                    await ack(request.requestId, "failed");
                  }
                }
              }
            }
          } catch {
            // DSH can temporarily outlive the island. Keep polling.
          } finally {
            active = false;
            if (!disposed) timer = window.setTimeout(poll, 350);
          }
        };
        ctx.effect(() => {
          timer = window.setTimeout(poll, 100);
          return () => {
            disposed = true;
            if (timer !== null) window.clearTimeout(timer);
          };
        }, "island-hud: exact Session navigation");
      },
    };
  },
});
