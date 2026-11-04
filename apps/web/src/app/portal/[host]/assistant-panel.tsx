"use client";

import "./assistant.css";

import {
  ASSISTANT_LIMITS,
  DICTATION_LIMITS,
  assistantPageFromPath,
  detectPlanIntent,
  type AnswerBlock,
  type AssistantLink,
  type AssistantPlan,
  type AssistantReply,
  type PlanIntent,
  type PublicCitation,
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
} from "react";

import { tourAssistantContext, type TourAssistantContext } from "@/lib/assistant-context";
import { useVisitorLocation } from "@/lib/use-visitor-location";

import {
  dictationSupported,
  speak,
  speechSupported,
  stopSpeaking,
  useDictation,
} from "./assistant-voice";
import { LocationButton } from "./visitor-location";

/**
 * The assistant's conversation (ADR-038), loaded only when the visitor opens it. A modal
 * on a phone (it covers the page), a side panel on a wider screen (the page stays usable).
 * The conversation lives in this browser for up to 24 hours (ADR-022): the server gets the
 * last messages with each question and keeps none of them. The visitor may dictate a
 * question (reviewed before sending) and hear the answers (ADR-041).
 */

const STORAGE_KEY = "rikuy.assistant.v1";
const ENDPOINT = "/asistente";
/** Places a plan may include, with coordinates: the phone measures its distance to each. */
const PLACES_ENDPOINT = "/asistente/lugares";
const WIDE = "(min-width: 48rem)";

type Shown = Exclude<AssistantReply, { status: "invalid" }>;

type Message =
  | { readonly id: string; readonly role: "user"; readonly text: string }
  | { readonly id: string; readonly role: "assistant"; readonly reply: Shown }
  | { readonly id: string; readonly role: "error"; readonly text: string };

interface Saved {
  readonly startedAt: number;
  readonly messages: readonly Message[];
}

/** Plans (ADR-039): the engine decides the stops, the model explains them. */
const PLANS: readonly { readonly intent: PlanIntent; readonly label: string }[] = [
  { intent: "nearby", label: "¿Qué hay cerca?" },
  { intent: "today", label: "Plan para hoy" },
  { intent: "route", label: "Ruta sugerida" },
];

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

const SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
  item: ["¿Qué puedo hacer aquí?", "¿Cómo llego?", "¿Qué más hay cerca?"],
  any: ["¿Qué lugares puedo visitar?", "¿Qué eventos hay próximamente?", "¿Qué se puede comer?"],
};

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
  readonly open: boolean;
  readonly onClose: () => void;
  readonly request?: AssistantRequestFromPage | null;
}

export default function AssistantPanel({
  name,
  named,
  greeting,
  siteName,
  open,
  onClose,
  request = null,
}: AssistantPanelProps) {
  const ids = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const [initial] = useState(load);
  const [messages, setMessages] = useState<Message[]>(() => [...initial.messages]);
  const [startedAt, setStartedAt] = useState(initial.startedAt);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const location = useVisitorLocation();
  const fix = location.fix;
  /** A plan that asked for the location: asked again once the phone knows where it is. */
  const waiting = useRef<{ text: string; intent: PlanIntent } | null>(null);
  // Voice (ADR-041): what the browser can do, decided once it runs.
  const canDictate = useSyncExternalStore(noSubscription, dictationSupported, () => false);
  const canSpeak = useSyncExternalStore(noSubscription, speechSupported, () => false);
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

  // Open as a modal on a phone, as a panel beside the page on a wider screen.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
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
  }, [open, cancelDictation]);

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
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question: asked,
            history: context,
            page: tour?.page ?? assistantPageFromPath(window.location.pathname),
            ...(tour ? { tour: { sceneId: tour.sceneId, hotspotId: tour.hotspotId } } : {}),
            ...(intent ? { intent } : {}),
            ...(distances && Object.keys(distances).length > 0 ? { distances } : {}),
          }),
        });
        const reply = (await response.json()) as AssistantReply;
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
    [busy, messages, fix, quiet, read],
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
    typeof window === "undefined" ? null : assistantPageFromPath(window.location.pathname);
  const onItem = page !== null && page.slug !== null;
  const suggestions = SUGGESTIONS[onItem ? "item" : "any"] ?? [];

  return (
    <dialog
      ref={dialog}
      className="assistant"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-note`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          // Escape first throws the recording away; then it closes the panel.
          if (recording) dictation.cancel();
          else onClose();
        }
      }}
    >
      <header className="assistant-header">
        <div>
          <h2 id={`${ids}-title`}>{name}</h2>
          <p className="assistant-subtitle">{named ? `Asistente de ${siteName}` : siteName}</p>
        </div>
        <div className="assistant-header-actions">
          {messages.length > 0 ? (
            <button type="button" className="assistant-quiet" onClick={restart}>
              Nueva conversación
            </button>
          ) : null}
          <button type="button" className="assistant-close" onClick={onClose}>
            <span aria-hidden="true">×</span>
            <span className="visually-hidden">Cerrar el asistente</span>
          </button>
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
        <div className="assistant-message assistant-from-assistant">
          <p>{greeting}</p>
        </div>
        {messages.length === 0 ? (
          <div className="assistant-suggestions" aria-label="Preguntas sugeridas" role="group">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="assistant-chip"
                onClick={() => void ask(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
        {messages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            name={name}
            speaking={speaking === message.id}
            onRead={
              canSpeak && message.role === "assistant"
                ? () => (speaking === message.id ? quiet() : read(message.id, message.reply))
                : null
            }
          />
        ))}
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

      <div className="assistant-plans" role="group" aria-label="Planes con lo publicado">
        {PLANS.map((plan) => (
          <button
            key={plan.intent}
            type="button"
            className="assistant-chip"
            disabled={busy}
            onClick={() => void ask(plan.label, plan.intent)}
          >
            {plan.label}
          </button>
        ))}
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
          Enviar
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
        Responde con inteligencia artificial a partir de lo publicado en este portal y puede
        equivocarse. La conversación se guarda solo en este dispositivo.{" "}
        <a href="/privacidad#asistente">Privacidad</a>
      </p>
    </dialog>
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
  if (links.length === 0) return null;
  return (
    <nav className="assistant-links" aria-label={label}>
      {links.map((link) => (
        <a key={link.href} href={link.href}>
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

function Sources({
  sources,
  lang,
}: {
  readonly sources: readonly PublicCitation[];
  readonly lang: "es" | "en";
}) {
  if (sources.length === 0) return null;
  return (
    <div className="assistant-sources">
      <p className="assistant-sources-title">{lang === "en" ? "Sources" : "Fuentes"}</p>
      <ul>
        {sources.map((source) => {
          const text = `${source.title}${source.page ? ` · ${source.page}` : ""}${source.ended ? (lang === "en" ? " · ended" : " · ya terminó") : ""}`;
          return (
            <li key={`${source.href ?? ""}${source.title}${source.page ?? ""}`}>
              <span className="assistant-source-kind">{source.label}</span>{" "}
              {source.href ? <a href={source.href}>{text}</a> : <span>{text}</span>}
            </li>
          );
        })}
      </ul>
    </div>
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
  name,
  speaking,
  onRead,
}: {
  readonly message: Message;
  readonly name: string;
  readonly speaking: boolean;
  readonly onRead: (() => void) | null;
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
      <div className="assistant-message assistant-from-assistant assistant-problem">
        <p>{message.text}</p>
      </div>
    );
  }
  const { reply } = message;
  if (reply.status === "notice") {
    return (
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
        <Contact contact={reply.notice.contact} lang={reply.lang} />
        {onRead ? <ReadButton speaking={speaking} lang={reply.lang} onRead={onRead} /> : null}
      </div>
    );
  }
  return (
    <div className="assistant-message assistant-from-assistant" lang={reply.lang}>
      <span className="visually-hidden">{name}: </span>
      <Blocks blocks={reply.blocks} />
      {reply.abstained ? (
        <p className="assistant-abstained">
          {reply.lang === "en" ? "No published source." : "Sin fuentes publicadas."}
        </p>
      ) : null}
      {reply.plan ? <PlanView plan={reply.plan} lang={reply.lang} /> : null}
      <Sources sources={reply.sources} lang={reply.lang} />
      <Links
        links={reply.links}
        label={reply.lang === "en" ? "Portal sections" : "Secciones del portal"}
      />
      <Contact contact={reply.contact} lang={reply.lang} />
      {onRead ? <ReadButton speaking={speaking} lang={reply.lang} onRead={onRead} /> : null}
    </div>
  );
}

function PlanView({ plan, lang }: { readonly plan: AssistantPlan; readonly lang: "es" | "en" }) {
  const en = lang === "en";
  if (plan.needsLocation) {
    return (
      <div className="assistant-plan">
        <LocationButton label={en ? "Use my location" : "Usar mi ubicación"} />
      </div>
    );
  }
  if (plan.stops.length === 0) return null;
  return (
    <section className="assistant-plan" aria-label={plan.title}>
      <p className="assistant-plan-title">
        {plan.title}
        {plan.start ? <span className="assistant-plan-start"> · {plan.start}</span> : null}
      </p>
      <ol className="assistant-plan-stops">
        {plan.stops.map((stop) => (
          <li key={stop.href} className="assistant-plan-stop">
            <span className="assistant-plan-number" aria-hidden="true">
              {stop.position}
            </span>
            <span className="assistant-plan-body">
              <a href={stop.href}>{stop.title}</a>
              <span className="assistant-plan-kind">
                {stop.kind === "event" ? (en ? "Event" : "Evento") : en ? "Place" : "Destino"}
              </span>
              {stop.time ? <span className="assistant-plan-time">{stop.time}</span> : null}
              {stop.distance ? (
                <span className="assistant-plan-distance">{stop.distance}</span>
              ) : null}
              {stop.note ? <span className="assistant-plan-note">{stop.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <p className="assistant-plan-hint">
        {en
          ? "Straight-line distances and estimated walking times."
          : "Distancias en línea recta y tiempos a pie estimados."}
      </p>
      {plan.mapHref ? (
        <a className="assistant-plan-map" href={plan.mapHref}>
          {plan.intent === "nearby"
            ? en
              ? "See them on the map"
              : "Verlos en el mapa"
            : en
              ? "See the route on the map"
              : "Ver la ruta en el mapa"}
        </a>
      ) : null}
    </section>
  );
}
