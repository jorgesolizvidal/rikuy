"use client";

import "./assistant.css";

import {
  ASSISTANT_LIMITS,
  DICTATION_LIMITS,
  assistantPageFromPath,
  detectPlanIntent,
  type AnswerBlock,
  type AssistantLink,
  type AssistantReply,
  type HelpDeskContact,
  type PlanIntent,
  type VisitLengthChoice,
} from "@rikuy/core/assistant-client";
import { distanceMeters, type PositionFix } from "@rikuy/core/geo";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";

import { tourAssistantContext, type TourAssistantContext } from "@/lib/assistant-context";
import { useVisitorLocation } from "@/lib/use-visitor-location";

import type { AssistantPlaceCard } from "./assistant-cards";
import {
  AssistantModeContext,
  linkProps,
  useLinkProps,
  type AssistantMode,
} from "./assistant-links";
import { HandoffCard } from "./assistant-handoff";
import { AnswerSources, PlanCard } from "./assistant-place";
import {
  dictationSupported,
  speak,
  speechSupported,
  stopSpeaking,
  useDictation,
} from "./assistant-voice";

/**
 * The assistant's conversation (ADR-038), loaded only when the visitor opens it. A modal
 * on a phone (it covers the page), a side panel on a wider screen (the page stays usable).
 * The conversation lives in this browser for up to 24 hours (ADR-022): the server gets the
 * last messages with each question and keeps none of them. The visitor may dictate a
 * question (reviewed before sending) and hear the answers (ADR-041).
 */

const STORAGE_KEY = "rikuy.assistant.v1";
const ENDPOINT = "/asistente";
/** Where the question was asked (ADR-071): the server decides the answer's links with it. */
const CHANNEL: Readonly<Record<AssistantMode, string>> = {
  launcher: "",
  page: "?canal=qr",
  embed: "?canal=insertar",
};
/** Places a plan may include, with coordinates: the phone measures its distance to each. */
const PLACES_ENDPOINT = "/asistente/lugares";
/** The visitor tapped a way to reach a person under an answer (ADR-073). */
const PERSON_ENDPOINT = "/asistente/persona";
const WIDE = "(min-width: 48rem)";

/** An answer and the cards of the places it names (ADR-065), as the portal sent them. */
type Shown = Exclude<AssistantReply, { status: "invalid" }> & {
  readonly places?: readonly AssistantPlaceCard[];
  /** The gateway's request (ADR-073): sent back if the visitor takes it to a person. */
  readonly ref?: string;
};

type Message =
  | { readonly id: string; readonly role: "user"; readonly text: string }
  | { readonly id: string; readonly role: "assistant"; readonly reply: Shown }
  | { readonly id: string; readonly role: "error"; readonly text: string }
  /** «Hablar con una persona» pressed (ADR-073): the card, shown here without the server. */
  | { readonly id: string; readonly role: "handoff"; readonly lang: "es" | "en" };

/** The question a person would get, and the answer it came with (ADR-073). */
interface Asked {
  readonly question: string | null;
  readonly ref: string | null;
}

/**
 * For each message that offers a person: the visitor's last question before it (never the
 * «quiero hablar con una persona» itself) and that answer's reference.
 */
function askedBefore(messages: readonly Message[]): ReadonlyMap<string, Asked> {
  const asked = new Map<string, Asked>();
  let question: string | null = null;
  let last: Asked = { question: null, ref: null };
  for (const message of messages) {
    if (message.role === "user") question = message.text;
    else if (message.role === "handoff") asked.set(message.id, last);
    else if (message.role === "assistant") {
      if (message.reply.status === "handoff") {
        asked.set(message.id, last);
      } else {
        last = { question, ref: message.reply.ref ?? null };
        asked.set(message.id, last);
      }
    }
  }
  return asked;
}

interface Saved {
  readonly startedAt: number;
  readonly messages: readonly Message[];
}

/** Plans (ADR-039): the engine decides the stops, the model explains them. */
const PLANS: readonly {
  readonly intent: PlanIntent;
  readonly label: string;
  readonly icon: Icon;
}[] = [
  { intent: "nearby", label: "¿Qué hay cerca?", icon: "pin" },
  { intent: "today", label: "Plan para hoy", icon: "calendar" },
  { intent: "route", label: "Ruta sugerida", icon: "route" },
];

/** «Plan para hoy» opens these (ADR-072); each is sent with «Con niños» when it is checked. */
const VISITS: readonly { readonly length: VisitLengthChoice; readonly label: string }[] = [
  { length: "1h", label: "1 hora" },
  { length: "2h", label: "2 horas" },
  { length: "half", label: "Medio día" },
  { length: "full", label: "Día completo" },
];

/** The question a chosen kind of visit sends: «Plan de 2 horas con niños». */
function visitQuestion(length: VisitLengthChoice, kids: boolean): string {
  const text =
    length === "1h"
      ? "Plan de 1 hora"
      : length === "2h"
        ? "Plan de 2 horas"
        : length === "half"
          ? "Plan de medio día"
          : "Plan de día completo";
  return kids ? `${text} con niños` : text;
}

interface ChosenVisit {
  readonly length: VisitLengthChoice;
  readonly kids: boolean;
}

interface PlacePoint {
  readonly key: string;
  readonly lat: number;
  readonly lng: number;
}

let placesRequest: Promise<readonly PlacePoint[]> | null = null;

function planPlaces(): Promise<readonly PlacePoint[]> {
  placesRequest ??= fetch(PLACES_ENDPOINT)
    .then((response) => (response.ok ? response.json() : { places: [] }))
    .then((body: { places?: PlacePoint[] }) => body.places ?? [])
    .catch(() => {
      placesRequest = null;
      return [];
    });
  return placesRequest;
}

/**
 * The visitor's distance to each place, measured here: only these numbers go to the
 * server (rounded there to 100 m), never the position (ADR-021, ADR-039).
 */
async function distancesFrom(fix: PositionFix): Promise<Record<string, number>> {
  const places = await planPlaces();
  return Object.fromEntries(
    places
      .slice(0, ASSISTANT_LIMITS.distances)
      .map((place) => [place.key, Math.round(distanceMeters(fix, place))]),
  );
}

const SUGGESTIONS: Readonly<
  Record<string, readonly { readonly text: string; readonly icon: Icon }[]>
> = {
  item: [
    { text: "¿Qué puedo hacer aquí?", icon: "spark" },
    { text: "¿Cómo llego?", icon: "route" },
    { text: "¿Qué más hay cerca?", icon: "pin" },
  ],
  any: [
    { text: "¿Qué lugares puedo visitar?", icon: "pin" },
    { text: "¿Qué eventos hay próximamente?", icon: "calendar" },
    { text: "¿Qué se puede comer?", icon: "food" },
  ],
};

type Icon = "pin" | "calendar" | "route" | "spark" | "food" | "person";

const ICON_PATHS: Readonly<Record<Icon, string>> = {
  pin: "M12 21s-6.5-6.6-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.4 12 21 12 21Zm0-8.7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  calendar:
    "M7 3v3m10-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  route:
    "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7",
  spark: "M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6",
  food: "M7 3v8m-2-8v5a2 2 0 0 0 4 0V3m-2 8v10m10-18c-2 0-3 2.5-3 6s1 4 3 4v8",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0",
};

/** A chip's small icon (decorative: the chip's text names it). */
function ChipIcon({ icon }: { readonly icon: Icon }) {
  return (
    <svg
      className="assistant-chip-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={ICON_PATHS[icon]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The assistant's face: the municipality's logo, or its initials (decorative). */
function Avatar({ logo, mark }: { readonly logo: string | null; readonly mark: string }) {
  return (
    <span className="assistant-avatar" aria-hidden="true">
      {logo ? (
        // The portal's own versioned logo (≤512 px WebP), already in the browser's cache.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" decoding="async" />
      ) : (
        mark
      )}
    </span>
  );
}

function NewIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.3 10l12.6 2-12.6 2 .1 6.4Z" />
    </svg>
  );
}

function load(): Saved {
  const fresh = { startedAt: Date.now(), messages: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fresh;
    const saved = JSON.parse(raw) as Saved;
    if (
      !Array.isArray(saved.messages) ||
      typeof saved.startedAt !== "number" ||
      Date.now() - saved.startedAt > ASSISTANT_LIMITS.keepMs
    ) {
      window.localStorage.removeItem(STORAGE_KEY);
      return fresh;
    }
    return saved;
  } catch {
    return fresh;
  }
}

function save(messages: readonly Message[], startedAt: number) {
  try {
    if (messages.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ startedAt, messages }));
  } catch {
    // Private mode or storage blocked: the conversation lasts as long as the page.
  }
}

function plain(blocks: readonly AnswerBlock[]): string {
  return blocks
    .map((block) => (block.type === "paragraph" ? block.text : block.items.join("; ")))
    .join(" ");
}

/** What goes back to the server as context: questions and answers, never notices. */
function history(messages: readonly Message[]) {
  return messages
    .flatMap((message): { role: "user" | "assistant"; text: string }[] =>
      message.role === "user"
        ? [{ role: "user", text: message.text }]
        : message.role === "assistant" && message.reply.status === "answered"
          ? [{ role: "assistant", text: plain(message.reply.blocks) }]
          : [],
    )
    .slice(-ASSISTANT_LIMITS.historyMessages);
}

/** What is read aloud: the answer and its plan's stops, never the sources or the links. */
function spoken(reply: Shown): string {
  if (reply.status === "notice") return reply.notice.message;
  if (reply.status === "handoff") {
    return reply.lang === "en"
      ? "You can write to or call the municipality: your question goes written in the message."
      : "Puedes escribir o llamar al municipio: tu consulta va escrita en el mensaje.";
  }
  const stops =
    reply.plan && !reply.plan.needsLocation
      ? reply.plan.stops.map(
          (stop) => `${stop.position}. ${stop.title}${stop.time ? `, ${stop.time}` : ""}.`,
        )
      : [];
  return [plain(reply.blocks), ...stops].join(" ");
}

const noSubscription = () => () => undefined;

let counter = 0;
const nextId = () => `m${Date.now().toString(36)}${(counter += 1)}`;

/** A question asked by another part of the page: the tour's guide buttons (ADR-040). */
export interface AssistantRequestFromPage {
  readonly id: number;
  readonly question: string;
  readonly intent: "guide";
  readonly tour: TourAssistantContext;
}

export interface AssistantPanelProps {
  readonly name: string;
  readonly named: boolean;
  readonly greeting: string;
  readonly siteName: string;
  /** The municipality's logo (ADR-065: the assistant's face), or its initials without one. */
  readonly logo: string | null;
  readonly mark: string;
  /** The municipality has the assistant's voice (ADR-060). */
  readonly voice: boolean;
  readonly open: boolean;
  /** Absent on its own page, where it never closes. */
  readonly onClose?: () => void;
  readonly request?: AssistantRequestFromPage | null;
  /** The portal's button (default), its own page, or the website's frame (ADR-071). */
  readonly mode?: AssistantMode;
  /** The portal page it is about, when not the browser's (a QR about a place: «/destinos/…»). */
  readonly pagePath?: string | null;
  /** «Atención al visitante» and the portal's phone and email (ADR-073); null: none. */
  readonly helpDesk: HelpDeskContact | null;
  /** The municipality's time zone: whether the help desk attends now. */
  readonly timezone: string;
}

export default function AssistantPanel({
  name,
  named,
  greeting,
  siteName,
  logo,
  mark,
  voice,
  open,
  onClose,
  request = null,
  mode = "launcher",
  pagePath = null,
  helpDesk,
  timezone,
}: AssistantPanelProps) {
  const close = useCallback(() => onClose?.(), [onClose]);
  const avatar = <Avatar logo={logo} mark={mark} />;
  const ids = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const [initial] = useState(load);
  const [messages, setMessages] = useState<Message[]>(() => [...initial.messages]);
  const [startedAt, setStartedAt] = useState(initial.startedAt);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  /** «Plan para hoy» shows the kinds of visit (ADR-072). */
  const [choosing, setChoosing] = useState(false);
  const [kids, setKids] = useState(false);
  const location = useVisitorLocation();
  const fix = location.fix;
  /** A plan that asked for the location: asked again once the phone knows where it is. */
  const waiting = useRef<{ text: string; intent: PlanIntent } | null>(null);
  // Voice (ADR-041): what the browser can do, decided once it runs.
  const canDictate = useSyncExternalStore(noSubscription, dictationSupported, () => false) && voice;
  const canSpeak = useSyncExternalStore(noSubscription, speechSupported, () => false) && voice;
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState<string | null>(null);
  /** The question in the field came (at least partly) from dictation: read its answer. */
  const fromVoice = useRef(false);
  const dictation = useDictation({
    onText: (text) => {
      fromVoice.current = true;
      setQuestion((current) => (current.trim() ? `${current.trim()} ${text}` : text));
      input.current?.focus();
    },
    onMessage: setVoiceMessage,
  });
  const cancelDictation = dictation.cancel;
  const recording = dictation.state.phase === "recording" || dictation.state.phase === "starting";
  const transcribing = dictation.state.phase === "sending";

  const read = useCallback((id: string, reply: Shown) => {
    setSpeaking(id);
    void speak(spoken(reply), reply.lang, () =>
      setSpeaking((current) => (current === id ? null : current)),
    );
  }, []);

  const quiet = useCallback(() => {
    stopSpeaking();
    setSpeaking(null);
  }, []);

  // «Pidió una persona» (ADR-073): once per answer, when a way to reach them is tapped. The
  // request survives the page opening WhatsApp or the phone app (keepalive).
  const told = useRef(new Set<string>());
  const tellPerson = useCallback(
    (asked: Asked) => {
      if (!asked.ref || !asked.question || told.current.has(asked.ref)) return;
      told.current.add(asked.ref);
      const tour = tourAssistantContext();
      void fetch(PERSON_ENDPOINT, {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ref: asked.ref,
          question: asked.question,
          page: tour?.page ?? assistantPageFromPath(pagePath ?? window.location.pathname),
          ...(tour ? { tour: { sceneId: tour.sceneId, hotspotId: tour.hotspotId } } : {}),
        }),
      }).catch(() => undefined);
    },
    [pagePath],
  );

  // Open as a modal on a phone, as a panel beside the page on a wider screen. On its own page
  // and in the website's frame it is the page itself: always open, never modal.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (mode !== "launcher") {
      if (!element.open) element.show();
      return;
    }
    if (open && !element.open) {
      // Over a fullscreen tour or a point's dialog, only a modal dialog is visible and usable.
      const over =
        document.fullscreenElement !== null || document.querySelector("dialog:modal") !== null;
      if (window.matchMedia(WIDE).matches && !over) element.show();
      else element.showModal();
      input.current?.focus();
    } else if (!open && element.open) {
      element.close();
      // Closing the panel stops the microphone and the voice.
      cancelDictation();
      stopSpeaking();
    }
  }, [open, cancelDictation, mode]);

  // In the website's frame (ADR-071): the website says when it shows the frame, and the
  // question field takes the focus then. Nothing else is read from the website.
  useEffect(() => {
    if (mode !== "embed") return;
    const shown = (event: MessageEvent) => {
      if (
        event.source === window.parent &&
        (event.data as { type?: unknown })?.type === "rikuy:open"
      ) {
        input.current?.focus();
      }
    };
    window.addEventListener("message", shown);
    window.parent.postMessage({ type: "rikuy:ready" }, "*");
    return () => window.removeEventListener("message", shown);
  }, [mode]);

  useEffect(() => {
    save(messages, startedAt);
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages, startedAt]);

  const ask = useCallback(
    async (
      text: string,
      intent: PlanIntent | "guide" | null = null,
      again = false,
      tourContext: TourAssistantContext | null = null,
      visit: ChosenVisit | null = null,
    ) => {
      const asked = text.replace(/\s+/gu, " ").trim();
      if (asked.length < 2 || busy) return;
      const context = history(messages);
      const dictated = fromVoice.current;
      fromVoice.current = false;
      setVoiceMessage(null);
      quiet();
      if (!again) {
        setMessages((current) => [...current, { id: nextId(), role: "user", text: asked }]);
      }
      setQuestion("");
      setBusy(true);
      try {
        // Distances only for a plan, and only when the visitor shares the location.
        const plan = intent === "guide" ? null : (intent ?? detectPlanIntent(asked));
        // Inside a tour: the scene and the point on screen, as IDs (ADR-040).
        const tour = tourContext ?? tourAssistantContext();
        const distances = plan && fix ? await distancesFrom(fix) : null;
        const response = await fetch(`${ENDPOINT}${CHANNEL[mode]}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question: asked,
            history: context,
            page: tour?.page ?? assistantPageFromPath(pagePath ?? window.location.pathname),
            ...(tour ? { tour: { sceneId: tour.sceneId, hotspotId: tour.hotspotId } } : {}),
            ...(intent ? { intent } : {}),
            ...(visit ? { visit } : {}),
            ...(distances && Object.keys(distances).length > 0 ? { distances } : {}),
          }),
        });
        const reply = (await response.json()) as Shown | { readonly status: "invalid" };
        if (!response.ok || reply.status === "invalid") throw new Error(String(response.status));
        const id = nextId();
        setMessages((current) => [...current, { id, role: "assistant", reply }]);
        // A question asked by voice is answered aloud too (ADR-041).
        if (dictated && speechSupported()) read(id, reply);
        // Asked again once the location is known — only if it was not known this time.
        if (reply.status === "answered" && reply.plan?.needsLocation && distances === null) {
          waiting.current = { text: asked, intent: reply.plan.intent };
        }
      } catch {
        setMessages((current) => [
          ...current,
          {
            id: nextId(),
            role: "error",
            text: "No pude conectarme. Revisa tu conexión e inténtalo de nuevo.",
          },
        ]);
      } finally {
        setBusy(false);
        input.current?.focus();
      }
    },
    [busy, messages, fix, quiet, read, mode, pagePath],
  );

  // A question from the page (the tour's «¿Qué estoy viendo?»): asked once it is open.
  const answered = useRef(0);
  useEffect(() => {
    if (!open || !request || request.id === answered.current || busy) return;
    answered.current = request.id;
    void ask(request.question, request.intent, false, request.tour);
  }, [open, request, busy, ask]);

  // The visitor shared the location after a plan asked for it: the same plan, now with it.
  useEffect(() => {
    const plan = waiting.current;
    if (!plan || !fix || busy) return;
    waiting.current = null;
    void ask(plan.text, plan.intent, true);
  }, [fix, busy, ask]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  function restart() {
    waiting.current = null;
    fromVoice.current = false;
    dictation.cancel();
    quiet();
    setVoiceMessage(null);
    setMessages([]);
    setStartedAt(Date.now());
    input.current?.focus();
  }

  const page =
    typeof window === "undefined"
      ? null
      : assistantPageFromPath(pagePath ?? window.location.pathname);
  const onItem = page !== null && page.slug !== null;
  const askedOf = askedBefore(messages);
  const suggestions = SUGGESTIONS[onItem ? "item" : "any"] ?? [];

  return (
    <AssistantModeContext.Provider value={mode}>
      <dialog
        ref={dialog}
        className="assistant"
        data-mode={mode}
        aria-labelledby={`${ids}-title`}
        aria-describedby={`${ids}-note`}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            // Escape first throws the recording away; then it closes the panel.
            if (recording) dictation.cancel();
            else close();
          }
        }}
      >
        <header className="assistant-header">
          {avatar}
          <div className="assistant-heading">
            <h2 id={`${ids}-title`}>{name}</h2>
            <p className="assistant-subtitle">
              {named ? `Asistente de ${siteName}` : siteName}
              <span className="assistant-status">Responde con lo publicado</span>
            </p>
          </div>
          <div className="assistant-header-actions">
            {messages.length > 0 ? (
              <button
                type="button"
                className="assistant-quiet"
                title="Nueva conversación"
                onClick={restart}
              >
                <NewIcon />
                <span className="visually-hidden">Nueva conversación</span>
              </button>
            ) : null}
            {onClose ? (
              <button type="button" className="assistant-close" onClick={close}>
                <span aria-hidden="true">×</span>
                <span className="visually-hidden">Cerrar el asistente</span>
              </button>
            ) : null}
          </div>
        </header>

        <div
          ref={log}
          className="assistant-log"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-busy={busy}
          tabIndex={0}
          aria-label="Conversación"
        >
          <div className="assistant-message assistant-from-assistant assistant-welcome">
            {avatar}
            <p>{greeting}</p>
          </div>
          {messages.length === 0 ? (
            <div className="assistant-suggestions" aria-labelledby={`${ids}-faq`} role="group">
              <p id={`${ids}-faq`} className="assistant-section-title">
                Preguntas frecuentes
              </p>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.text}
                  type="button"
                  className="assistant-chip"
                  onClick={() => void ask(suggestion.text)}
                >
                  <ChipIcon icon={suggestion.icon} />
                  {suggestion.text}
                </button>
              ))}
            </div>
          ) : null}
          {messages.map((message) => {
            const asked = askedOf.get(message.id) ?? { question: null, ref: null };
            return (
              <MessageView
                key={message.id}
                message={message}
                avatar={avatar}
                name={name}
                speaking={speaking === message.id}
                onRead={
                  canSpeak && message.role === "assistant"
                    ? () => (speaking === message.id ? quiet() : read(message.id, message.reply))
                    : null
                }
                hasDesk={helpDesk !== null}
                handoff={(lang) => (
                  <HandoffCard
                    desk={helpDesk}
                    siteName={siteName}
                    timezone={timezone}
                    lang={lang}
                    question={asked.question}
                    onContact={() => tellPerson(asked)}
                  />
                )}
              />
            );
          })}
          {busy ? (
            <p className="assistant-typing">
              <span aria-hidden="true" className="assistant-dots">
                <span />
                <span />
                <span />
              </span>
              {name} está escribiendo…
            </p>
          ) : null}
        </div>

        <div className="assistant-plans" role="group" aria-label="Planes y ayuda">
          {PLANS.map((plan) =>
            plan.intent === "today" ? (
              <button
                key={plan.intent}
                type="button"
                className="assistant-chip"
                disabled={busy}
                aria-expanded={choosing}
                aria-controls={`${ids}-visit`}
                onClick={() => setChoosing((current) => !current)}
              >
                <ChipIcon icon={plan.icon} />
                {plan.label}
              </button>
            ) : (
              <button
                key={plan.intent}
                type="button"
                className="assistant-chip"
                disabled={busy}
                onClick={() => {
                  setChoosing(false);
                  void ask(plan.label, plan.intent);
                }}
              >
                <ChipIcon icon={plan.icon} />
                {plan.label}
              </button>
            ),
          )}
          {helpDesk ? (
            <button
              type="button"
              className="assistant-chip assistant-chip-person"
              disabled={busy}
              onClick={() => {
                setChoosing(false);
                quiet();
                const lang =
                  [...messages]
                    .reverse()
                    .find(
                      (message): message is Extract<Message, { role: "assistant" }> =>
                        message.role === "assistant",
                    )?.reply.lang ?? "es";
                setMessages((current) => [...current, { id: nextId(), role: "handoff", lang }]);
              }}
            >
              <ChipIcon icon="person" />
              Hablar con una persona
            </button>
          ) : null}
        </div>
        <div
          id={`${ids}-visit`}
          className="assistant-visit"
          role="group"
          aria-labelledby={`${ids}-visit-title`}
          hidden={!choosing}
        >
          <p id={`${ids}-visit-title`} className="assistant-visit-title">
            ¿Cuánto tiempo tienes?
          </p>
          <div className="assistant-visit-lengths">
            {VISITS.map((visit) => (
              <button
                key={visit.length}
                type="button"
                className="assistant-chip"
                disabled={busy}
                onClick={() => {
                  setChoosing(false);
                  void ask(visitQuestion(visit.length, kids), "today", false, null, {
                    length: visit.length,
                    kids,
                  });
                }}
              >
                {visit.label}
              </button>
            ))}
          </div>
          <label className="assistant-visit-kids">
            <input
              type="checkbox"
              checked={kids}
              onChange={(event) => setKids(event.target.checked)}
            />
            Con niños
          </label>
        </div>

        <form className="assistant-form" onSubmit={submit}>
          <label htmlFor={`${ids}-question`} className="visually-hidden">
            Tu pregunta para {name}
          </label>
          <textarea
            ref={input}
            id={`${ids}-question`}
            rows={1}
            maxLength={ASSISTANT_LIMITS.question}
            placeholder="Escribe tu pregunta"
            value={question}
            enterKeyHint="send"
            onChange={(event) => {
              setQuestion(event.target.value);
              if (!event.target.value.trim()) fromVoice.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void ask(question);
              }
            }}
          />
          {canDictate ? (
            <button
              type="button"
              className="assistant-mic"
              data-recording={recording ? "" : undefined}
              disabled={transcribing}
              aria-describedby={`${ids}-voice`}
              onClick={() => (recording ? dictation.stop() : void dictation.start())}
            >
              <MicIcon />
              <span className="visually-hidden">
                {recording ? "Terminar de dictar" : "Dictar la pregunta"}
              </span>
            </button>
          ) : null}
          <button
            type="submit"
            className="assistant-send"
            disabled={busy || recording || transcribing || question.trim().length < 2}
          >
            <SendIcon />
            <span className="visually-hidden">Enviar</span>
          </button>
        </form>
        <p id={`${ids}-voice`} className="assistant-voice" role="status">
          {dictation.state.phase === "recording" ? (
            <>
              <span className="assistant-rec" aria-hidden="true" />
              Escuchando… {dictation.state.seconds} s de {DICTATION_LIMITS.maxSeconds}. Toca el
              micrófono cuando termines.
            </>
          ) : transcribing ? (
            "Pasando tu voz a texto…"
          ) : (
            voiceMessage
          )}
        </p>
        <p id={`${ids}-note`} className="assistant-note">
          Responde con inteligencia artificial a partir de lo publicado por el municipio y puede
          equivocarse. La conversación se guarda solo en este dispositivo.{" "}
          <a {...linkProps("/privacidad#asistente", mode)}>Privacidad</a>
        </p>
      </dialog>
    </AssistantModeContext.Provider>
  );
}

function Blocks({ blocks }: { readonly blocks: readonly AnswerBlock[] }) {
  return (
    <>
      {blocks.map((block, index) =>
        block.type === "paragraph" ? (
          <p key={index}>{block.text}</p>
        ) : (
          <ul key={index}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{item}</li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

function Links({
  links,
  label,
}: {
  readonly links: readonly AssistantLink[];
  readonly label: string;
}) {
  const attributes = useLinkProps();
  if (links.length === 0) return null;
  return (
    <nav className="assistant-links" aria-label={label}>
      {links.map((link) => (
        <a key={link.href} {...attributes(link.href)}>
          {link.label}
        </a>
      ))}
    </nav>
  );
}

function Contact({
  contact,
  lang,
}: {
  readonly contact: { readonly phone?: string; readonly email?: string } | null;
  readonly lang: "es" | "en";
}) {
  if (!contact) return null;
  return (
    <p className="assistant-contact">
      {lang === "en" ? "Contact: " : "Contacto: "}
      {contact.phone ? (
        <a href={`tel:${contact.phone.replace(/[^\d+]/gu, "")}`}>{contact.phone}</a>
      ) : null}
      {contact.phone && contact.email ? " · " : null}
      {contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : null}
    </p>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
      />
    </svg>
  );
}

function ReadButton({
  speaking,
  lang,
  onRead,
}: {
  readonly speaking: boolean;
  readonly lang: "es" | "en";
  readonly onRead: () => void;
}) {
  const en = lang === "en";
  return (
    <button type="button" className="assistant-read" aria-pressed={speaking} onClick={onRead}>
      {speaking ? (en ? "Stop reading" : "Detener la lectura") : en ? "Listen" : "Escuchar"}
    </button>
  );
}

function MessageView({
  message,
  avatar,
  name,
  speaking,
  onRead,
  hasDesk,
  handoff,
}: {
  readonly message: Message;
  readonly avatar: ReactNode;
  readonly name: string;
  readonly speaking: boolean;
  readonly onRead: (() => void) | null;
  /** The municipality has someone to reach (ADR-073). */
  readonly hasDesk: boolean;
  /** «Hablar con una persona»: who to write or call, with the last question written. */
  readonly handoff: (lang: "es" | "en") => ReactNode;
}) {
  if (message.role === "user") {
    return (
      <div className="assistant-message assistant-from-visitor">
        <p>
          <span className="visually-hidden">Tú: </span>
          {message.text}
        </p>
      </div>
    );
  }
  if (message.role === "error") {
    return (
      <div className="assistant-row">
        {avatar}
        <div className="assistant-message assistant-from-assistant assistant-problem">
          <p>{message.text}</p>
        </div>
      </div>
    );
  }
  if (message.role === "handoff") {
    return (
      <div className="assistant-row">
        {avatar}
        <div className="assistant-message assistant-from-assistant" lang={message.lang}>
          <span className="visually-hidden">{name}: </span>
          {handoff(message.lang)}
        </div>
      </div>
    );
  }
  const { reply } = message;
  if (reply.status === "handoff") {
    return (
      <div className="assistant-row">
        {avatar}
        <div className="assistant-message assistant-from-assistant" lang={reply.lang}>
          <span className="visually-hidden">{reply.speaker}: </span>
          <p>
            {reply.lang === "en"
              ? "Of course. This is how you can reach a person:"
              : "Claro. Así puedes hablar con una persona:"}
          </p>
          {handoff(reply.lang)}
          {onRead ? <ReadButton speaking={speaking} lang={reply.lang} onRead={onRead} /> : null}
        </div>
      </div>
    );
  }
  if (reply.status === "notice") {
    return (
      <div className="assistant-row">
        {avatar}
        <div
          className="assistant-message assistant-from-assistant assistant-problem"
          lang={reply.lang}
        >
          <p>
            <span className="visually-hidden">{reply.notice.speaker}: </span>
            {reply.notice.message}
          </p>
          <Links
            links={reply.notice.links}
            label={reply.lang === "en" ? "Portal sections" : "Secciones del portal"}
          />
          {hasDesk ? (
            handoff(reply.lang)
          ) : (
            <Contact contact={reply.notice.contact} lang={reply.lang} />
          )}
          {onRead ? <ReadButton speaking={speaking} lang={reply.lang} onRead={onRead} /> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="assistant-row">
      {avatar}
      <div className="assistant-message assistant-from-assistant" lang={reply.lang}>
        <span className="visually-hidden">{name}: </span>
        <Blocks blocks={reply.blocks} />
        {reply.abstained ? (
          <p className="assistant-abstained">
            {reply.lang === "en" ? "No published source." : "Sin fuentes publicadas."}
          </p>
        ) : null}
        {reply.plan ? <PlanCard plan={reply.plan} cards={reply.places} lang={reply.lang} /> : null}
        <AnswerSources sources={reply.sources} cards={reply.places} lang={reply.lang} />
        <Links
          links={reply.links}
          label={reply.lang === "en" ? "Portal sections" : "Secciones del portal"}
        />
        {reply.abstained && hasDesk ? (
          handoff(reply.lang)
        ) : (
          <Contact contact={reply.contact} lang={reply.lang} />
        )}
        {onRead ? <ReadButton speaking={speaking} lang={reply.lang} onRead={onRead} /> : null}
      </div>
    </div>
  );
}
