"use client";

import {
  emailMessageHref,
  handoffMessage,
  helpDeskName,
  phoneHref,
  whatsappMessageHref,
  type HelpDeskContact,
} from "@rikuy/core/assistant-client";
import { describeOpenState, localClock, openStateAt } from "@rikuy/core/geo";
import { useSyncExternalStore } from "react";

/**
 * «Hablar con una persona» (ADR-073): who answers, whether they attend now, and the message
 * already written with the visitor's last question. The visitor sends it; nothing passes
 * through Rikuy. Tapping a way to reach them tells the portal once («pidió una persona»).
 */

const MINUTE = 60_000;

function subscribe(listener: () => void) {
  const timer = window.setInterval(listener, MINUTE);
  return () => window.clearInterval(timer);
}

const minute = () => Math.floor(Date.now() / MINUTE);

export interface HandoffCardProps {
  readonly desk: HelpDeskContact | null;
  readonly siteName: string;
  readonly timezone: string;
  readonly lang: "es" | "en";
  /** The visitor's last question before asking for a person; null: none yet. */
  readonly question: string | null;
  /** Tapped WhatsApp, «Llamar» or the email. */
  readonly onContact: () => void;
}

function Hours({
  desk,
  timezone,
  lang,
}: {
  readonly desk: HelpDeskContact;
  readonly timezone: string;
  readonly lang: "es" | "en";
}) {
  const now = useSyncExternalStore(subscribe, minute, () => null);
  if (!desk.hours) return null;
  const state =
    now === null ? null : openStateAt(desk.hours, localClock(new Date(now * MINUTE), timezone));
  const open = state !== null && (state.state === "open" || state.state === "always");
  const text = state === null ? null : describeOpenState(state, lang);
  return (
    <p className="assistant-handoff-hours" data-open={state === null ? undefined : open}>
      {text ?? " "}
    </p>
  );
}

export function HandoffCard({
  desk,
  siteName,
  timezone,
  lang,
  question,
  onContact,
}: HandoffCardProps) {
  const en = lang === "en";
  if (!desk) {
    return (
      <p className="assistant-handoff-none">
        {en
          ? "The municipality has not published how to contact it yet."
          : "El municipio todavía no publicó cómo contactarlo."}
      </p>
    );
  }
  const message = handoffMessage(siteName, question, lang);
  const who = helpDeskName(desk, lang);
  return (
    <section className="assistant-handoff" aria-label={en ? `Talk to ${who}` : `Hablar con ${who}`}>
      <p className="assistant-handoff-title">
        {desk.name ?? (en ? "Visitor help" : "Atención al visitante")}
      </p>
      <Hours desk={desk} timezone={timezone} lang={lang} />
      <p className="assistant-handoff-lead">
        {question
          ? en
            ? "Your question is already written in the message."
            : "Tu consulta ya va escrita en el mensaje."
          : en
            ? "Write to them or call them."
            : "Escríbeles o llámalos."}
      </p>
      <div className="assistant-handoff-actions">
        {desk.whatsapp ? (
          <a
            className="assistant-handoff-action assistant-handoff-main"
            href={whatsappMessageHref(desk.whatsapp, message)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onContact}
          >
            {en ? "Write on WhatsApp" : "Escribir por WhatsApp"}
          </a>
        ) : null}
        {desk.phone ? (
          <a className="assistant-handoff-action" href={phoneHref(desk.phone)} onClick={onContact}>
            {en ? "Call" : "Llamar"}
            <span className="assistant-handoff-detail"> {desk.phone}</span>
          </a>
        ) : null}
        {desk.email ? (
          <a
            className="assistant-handoff-action"
            href={emailMessageHref(desk.email, siteName, message, lang)}
            onClick={onContact}
          >
            {en ? "Write an email" : "Escribir un correo"}
          </a>
        ) : null}
      </div>
      <p className="assistant-handoff-note">
        {en
          ? "You send the message from your phone, and the municipality reads it."
          : "El mensaje lo envías tú desde tu teléfono y lo lee el municipio."}
      </p>
    </section>
  );
}
