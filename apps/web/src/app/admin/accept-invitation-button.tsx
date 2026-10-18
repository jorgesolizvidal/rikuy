"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { acceptInvitationAction, type AcceptState } from "./invitation.action";

const IDLE: AcceptState = { status: "idle" };

export function AcceptInvitationButton({ tenantId }: { readonly tenantId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(acceptInvitationAction, IDLE);

  useEffect(() => {
    if (state.status === "accepted") router.refresh();
  }, [state, router]);

  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="tenantId" value={tenantId} />
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Aceptando…" : "Aceptar"}
      </button>
      {state.status === "not_found" || state.status === "error" ? (
        <span className="org-detail" role="status">
          {state.status === "not_found"
            ? "Esta invitación ya no está disponible."
            : "No se pudo aceptar. Inténtalo de nuevo."}
        </span>
      ) : null}
    </form>
  );
}
