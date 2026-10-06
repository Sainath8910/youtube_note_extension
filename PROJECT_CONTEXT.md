# 1. Project Overview

- **Project name:** YouTube Knowledge Extension (from the Chrome extension manifest); the repository folder is `youtube-knowledge-extension`.
- **What it does:** A Chrome Manifest V3 extension adds a React sidebar to YouTube watch pages. The sidebar supports video-linked structured notes, transcript retrieval, AI-generated video analysis, retrieval-augmented questions, and “Previous Context” based on a user's notes and the current video's analysis.
- **Main purpose:** Connect learning from a YouTube video with a user's saved notes and related prior knowledge.
- **Target users/use case:** People watching educational YouTube videos who want to capture notes, inspect transcript-based analysis, and ask questions grounded in their own indexed material.
- **Current status:** The repository contains working backend services, Django tests, and extension UI/API wiring, but is configured for local development (localhost backend, development-header authentication, Docker Compose services). The extension package's standalone `App.tsx` is still the Vite starter screen. No production deployment configuration or release documentation was found.
- **Major features:**
  - Video metadata lookup and per-user video notes.
  - Versioned rich-note documents with paragraph, heading, equation, timestamp, and image block types in the extension.
  - Transcript retrieval and transcript-based structured video analysis.
  - 1024-dimensional embeddings and PostgreSQL/pgvector semantic retrieval over note, transcript, and analysis chunks.
  - Grounded AI answers with returned source chunks.
  - Synchronous and Kafka-worker-backed Previous Context, including exact notes for a video, related personal notes, and analysis-derived prerequisite/upcoming concepts.
  - Sidebar theme and position preferences stored in Chrome local extension storage.

# 2. Technology Stack

| Area | Technology | Where and how it is used |
|---|---|---|
| Language | Python | Django backend, data models, service layer, management commands, and tests in `backend/`. |
| Language | TypeScript / TSX | Chrome extension UI, content script, service worker, and message/API types in `extension/src/`. TypeScript is declared at `~6.0.2`. |
| Backend framework | Django | Project configuration, ORM, admin, authentication, migrations, WSGI/ASGI entry points, and management commands. Requirements constrain Django to `>=6.1,<6.2`. |
| Backend API | Django REST Framework | Authenticated JSON API views and serializers. Requirements constrain DRF to `>=3.18,<3.19`. |
| Frontend framework | React and React DOM | React 19 UI mounted in the YouTube page by `content.tsx`; also used by the scaffold Vite app. |
| Frontend/build libraries | Vite, `@vitejs/plugin-react`, TypeScript | Build the extension's page app, content script, and background service worker. `extension/package.json` defines `build`, `dev`, `lint`, and `preview` scripts. |
| UI/icons | Plain CSS and `lucide-react` | Extension styles are in `Sidebar.css`-adjacent `index.css`/`App.css` and inline theme-aware component styles; Lucide supplies sidebar icons. No component framework is declared. |
| Database | PostgreSQL 17 with pgvector | Django settings select PostgreSQL; Docker Compose provides `pgvector/pgvector:pg17`. `KnowledgeChunk.embedding` is a 1024-dimensional vector and retrieval orders by cosine distance. `backend/db.sqlite3` exists locally, but it is not the configured Django database. |
| Authentication | Django auth/session authentication plus `DevHeaderAuthentication` | DRF defaults to `IsAuthenticated`. A development-only `X-Dev-User` header resolves an existing user while `DEBUG` is enabled; session authentication is also configured. No public signup/token/OAuth API was found. |
| External APIs | YouTube transcript library and `yt-dlp` | `youtube-transcript-api` fetches caption segments; `yt-dlp` extracts video title/channel/duration metadata without downloading the media. |
| AI generation | Google Gemini (`google-genai`) | Gemini generates grounded RAG answers and is the first video-analysis provider. Model names and API-key environment variable names are read by the relevant services; secret values are not documented here. |
| AI analysis fallback | Hugging Face Inference API (`huggingface_hub`) | `HuggingFaceAnalysisProvider` is tried after Gemini in the video analysis provider manager. |
| Embeddings / ML | PyTorch, Transformers, Hugging Face model hub | The backend lazily loads the pinned Qwen3 Embedding model/revision using `AutoTokenizer` and `AutoModel`; the model produces normalized 1024-dimensional vectors. CUDA is selected when available, otherwise CPU. |
| Event queue | Kafka via `confluent-kafka` | Previous Context job creation publishes a versioned pointer event after the database transaction commits. A Django management command consumes events and processes persisted PostgreSQL jobs. |
| Storage | PostgreSQL | Stores users, notes, videos, transcripts, analysis, jobs, and knowledge chunks. No external object/file storage service was found. |
| Browser storage | Chrome Extension Storage API | Stores sidebar position and theme using `chrome.storage.local`; it is not used for notes or analysis persistence. |
| Package managers | `pip`/Python requirements and `npm` | Python dependencies are listed in `backend/requirements.txt`; frontend dependencies and lockfile are in `extension/package.json` and `extension/package-lock.json`. |
| Containers / local infrastructure | Docker Compose | Starts PostgreSQL/pgvector and Kafka. It does not define Django or extension containers. |
| Deployment / hosting | Not found in the repository | The extension API URL and manifest host permissions target localhost. No production hosting, release, or CI configuration was found. |
| Other | Django migrations and management commands | Schema history is under each app's `migrations/`; commands support note re-indexing and the Previous Context worker. |

The backend loads `backend/.env` via `python-dotenv`. Relevant variable **names** referenced in source include `GEMINI_API_KEY`, `GEMINI_GENERATION_MODEL`, `GEMINI_ANALYSIS_MODEL`, `HF_TOKEN`, `HF_ANALYSIS_MODEL`, `KNOWLEDGE_EMBEDDING_MODEL`, `KNOWLEDGE_EMBEDDING_REVISION`, `KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION`, `KNOWLEDGE_EMBEDDING_BATCH_SIZE`, `KNOWLEDGE_KAFKA_BOOTSTRAP_SERVERS`, `KNOWLEDGE_PREVIOUS_CONTEXT_KAFKA_TOPIC`, and `KNOWLEDGE_PREVIOUS_CONTEXT_KAFKA_GROUP`. No values from environment or local env files are included.

# 3. Repository / Folder Structure

```text
youtube-knowledge-extension/
├── docker-compose.yml
├── backend/
│   ├── manage.py
│   ├── requirements.txt
│   ├── config/
│   │   ├── settings.py
│   │   ├── urls.py
│   │   ├── asgi.py
│   │   └── wsgi.py
│   ├── users/
│   │   ├── models.py
│   │   ├── authentication.py
│   │   └── migrations/
│   ├── folders/
│   │   ├── models.py
│   │   ├── views.py
│   │   └── migrations/
│   ├── videos/
│   │   ├── models.py
│   │   ├── views.py
│   │   ├── urls.py
│   │   ├── serializers.py
│   │   ├── services/
│   │   │   ├── analysis.py
│   │   │   ├── analysis_providers.py
│   │   │   ├── transcript.py
│   │   │   └── youtube.py
│   │   └── migrations/
│   ├── notes/
│   │   ├── models.py
│   │   ├── views.py
│   │   ├── serializers.py
│   │   └── migrations/
│   ├── questions/
│   │   ├── models.py
│   │   └── migrations/
│   └── knowledge/
│       ├── models.py
│       ├── views.py
│       ├── urls.py
│       ├── serializers.py
│       ├── services/
│       │   ├── embeddings.py
│       │   ├── indexing.py
│       │   ├── transcript_indexing.py
│       │   ├── analysis_indexing.py
│       │   ├── retrieval.py
│       │   ├── context.py
│       │   ├── generation.py
│       │   ├── rag.py
│       │   ├── previous_context.py
│       │   ├── previous_context_jobs.py
│       │   └── previous_context_events.py
│       ├── management/commands/
│       │   ├── index_notes.py
│       │   └── run_previous_context_worker.py
│       ├── migrations/
│       └── tests_*.py
└── extension/
    ├── package.json
    ├── package-lock.json
    ├── public/
    │   └── manifest.json
    ├── index.html
    ├── vite.config.ts
    ├── vite.content.config.ts
    ├── vite.background.config.ts
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── Sidebar.tsx
        ├── content.tsx
        ├── background.ts
        ├── ragApi.ts
        ├── youtubeMetadata.ts
        └── *.css
```

Important files/directories:

- `docker-compose.yml`: local PostgreSQL/pgvector and Kafka services.
- `backend/config/`: Django settings and project URL/WSGI/ASGI configuration.
- `backend/users/`: custom `AbstractUser` subclass and development-header authentication.
- `backend/folders/`, `backend/questions/`: data models exist; no corresponding API URL modules are wired into the project URL configuration.
- `backend/videos/`: video/transcript/analysis models, endpoints, serializers, and YouTube/provider integrations.
- `backend/notes/`: structured note persistence, validation, CRUD endpoints, and note indexing on create/update.
- `backend/knowledge/`: vector index model, RAG and Previous Context APIs/services, asynchronous worker, and related tests.
- `backend/*/migrations/`: Django schema history. Notable additions include note JSON documents (`notes/0003`), pgvector embeddings (`knowledge/0002`), source types (`knowledge/0003` and later alterations), and Previous Context job records (`knowledge/0006`).
- `backend/knowledge/tests_*.py`, plus `tests.py` in backend apps: tests for API behavior, indexing, retrieval, generation, transcript/video pipeline, and Previous Context. The repository also has `notes/tests_indexing_integration.py`.
- `extension/public/manifest.json`: Chrome Manifest V3 permissions, YouTube content-script matching, and background worker declaration.
- `extension/src/content.tsx`: detects YouTube SPA video changes and mounts the sidebar.
- `extension/src/Sidebar.tsx`: primary extension UI, note editor/reader, analysis view, AI workspace, and theme/position handling.
- `extension/src/background.ts`: privileged extension message handler that performs localhost backend `fetch` calls.
- `extension/src/ragApi.ts`: client types, Previous Context job polling, response validation, and AI message helpers.
- `extension/src/App.tsx` and `main.tsx`: Vite development app entry; `App.tsx` is currently a starter counter page and is not the YouTube content-script UI.
- `extension/vite*.config.ts`: separate Vite builds for the normal app, content script, and background service worker.
- `dashboard/` and `docs/` contain no project source/document files in the inspected repository listing. No root README, CI workflow, or deployment manifest was found.

# 4. System Architecture

## Components and communication

- **Frontend:** Chrome extension content script injects a React sidebar into YouTube `/watch` pages. It communicates with the extension background service worker using `chrome.runtime.sendMessage`.
- **Backend:** Django + Django REST Framework at the local development URL used by the extension (`http://localhost:8000`). `backend/config/urls.py` mounts note, video, and knowledge routes under `/api/`.
- **Database:** PostgreSQL with pgvector. User-owned notes, video associations, analysis and knowledge chunks are persisted here. A local SQLite file is present but is not the active configured database.
- **External services:** YouTube is queried for metadata and transcript captions. Google Gemini and Hugging Face provide generative analysis; Gemini also generates RAG answers. A local Transformers/PyTorch model generates embeddings.
- **Authentication:** DRF requires an authenticated user by default. The extension currently uses the development-only header authenticator; Django session authentication is configured as an alternative. There is no extension login flow in the inspected source.
- **Storage:** PostgreSQL for application data and Chrome local storage for UI preferences. No separate file/blob store is configured.
- **Background work:** A Kafka consumer command processes Previous Context jobs. Jobs/results remain authoritative in PostgreSQL; Kafka messages contain job identity fields and point back to the stored job. Note/transcript/analysis embedding work is called synchronously from the related request paths.
- **AI/ML:** Embeddings feed cosine-distance retrieval. Video analysis consumes persisted transcript segments and saves structured results. RAG answer generation receives retrieved chunks and returns those chunks as source references.

```text
YouTube watch page
  |
  v
Chrome content script (content.tsx) ---- detects video ID / mounts Sidebar.tsx
  |                                           |
  |                               chrome.runtime.sendMessage
  |                                           v
  |                                 Extension background.js
  |                                           |
  |                    HTTP + development user header (localhost:8000)
  |                                           v
  +------------------------------------> Django REST API
                                              |
                  +---------------------------+-----------------------+
                  |                           |                       |
                  v                           v                       v
       PostgreSQL + pgvector          YouTube metadata/captions   Gemini / Hugging Face
       notes, videos, chunks, jobs    yt-dlp + transcript API     analysis / RAG generation
                  ^
                  |
       Kafka Previous Context job event
                  ^
                  |
       Django Previous Context worker
```

The extension manifest grants storage permission and host access for localhost and YouTube. The background script, rather than the injected content UI, sends API requests. The backend route modules are `notes.urls`, `videos.urls`, and `knowledge.urls`; folder/question models are not API routes at present.

# 5. Application Data Flow

## A. Opening a YouTube video and loading saved state

1. `content.tsx` checks the current URL for `/watch?v=...`, polling for SPA URL changes.
2. It sends `GET_VIDEO_CONTEXT` with the YouTube ID to the extension service worker.
3. The service worker calls `GET /api/videos/<youtube_id>/`.
4. Django returns `saved: false` with no video/notes if the shared `Video` row does not exist; merely opening a video does not create one.
5. If a video exists, the backend returns its metadata/status/analysis and only the requesting user's notes for that video.
6. The sidebar renders the response. Sidebar movement and theme are read/written separately in `chrome.storage.local`.

## B. Creating or updating a note

1. The user composes a note document in the sidebar and sends a create/update message.
2. For video-associated creation, the background script posts `youtube_id`, note title/document and related fields to `/api/notes/video/`.
3. Django validates the YouTube ID and tries `yt-dlp` metadata extraction. If metadata lookup fails, it records fallback metadata/thumbnail information rather than rejecting an otherwise valid note.
4. It gets or creates a global `Video`, validates the note, saves it, and calls `knowledge.services.indexing.index_note` in a transaction.
5. Supported textual blocks become note chunks; the embedding service generates vectors and old chunks for that note are replaced.
6. The response includes metadata about video creation/resolution plus serialized video and note. Indexing failure becomes a 502 and the surrounding transaction rolls back the note operation.
7. Updates use `PATCH /api/notes/<id>/` and also re-index; delete removes the note and cascading knowledge chunks.

## C. Fetching and indexing a transcript

1. The sidebar requests transcript retrieval through the extension background message `FETCH_TRANSCRIPT`.
2. `POST /api/videos/<youtube_id>/transcript/` validates the 11-character YouTube ID and gets or creates the shared video row.
3. The transcript service selects an available transcript (preferring English variants) using `youtube-transcript-api`, validates segments, then persists language, segments, fetch time, and status.
4. The backend calls transcript chunking/embedding for the requesting user. Transcript chunks retain start/end timestamps in metadata.
5. Transcript indexing errors are logged, but the transcript endpoint still returns the fetched transcript/status. Fetch failures return an error and mark transcript status failed.

## D. Video analysis and indexing

1. The user asks the background worker to call `POST /api/videos/<youtube_id>/analyze/`.
2. Analysis requires a persisted, ready, non-empty transcript; otherwise the endpoint returns a conflict.
3. The analysis provider manager tries Gemini first, then Hugging Face Inference. Both are asked for structured JSON and the response is checked against the transcript-derived schema/timestamps.
4. The result is saved as the video's one-to-one `VideoAnalysis`, and status becomes `READY`.
5. Analysis sections are converted into chunks and embedded for the requesting user. Indexing failures are logged without changing the successful analysis response.

## E. Asking a knowledge question (RAG)

1. The sidebar sends an `ASK_RAG` message with a question and scope.
2. The extension background script posts to `/api/knowledge/ask/`.
3. The API validates scope/context and creates a retrieval request for the authenticated user.
4. The retrieval service embeds the question, filters the user's indexed chunks by requested scope, and ranks them by pgvector cosine distance.
5. Context assembly carries chunk IDs, text, distances, note/video/folder IDs and metadata into the generation service.
6. Gemini is prompted to answer only from this retrieved material; no retrieved chunks yields a fixed insufficient-context answer without calling Gemini.
7. The API returns `answer` and `sources`. Retrieval failures map to 400; generation failures map to 502.

## F. Previous Context

1. The sidebar's `ragApi.ts` creates a job through `POST /api/knowledge/previous-context/jobs/`.
2. Django persists a `PENDING` `PreviousContextJob`, then publishes a versioned Kafka event after commit.
3. `run_previous_context_worker` consumes/validates events and uses the persisted job as the source of truth. `run_previous_context_job` claims a pending row under a database lock, computes context, and stores `READY` result or `FAILED` status.
4. The extension polls the job status (first after 500 ms, then every 1.5 seconds, up to 40 attempts). The endpoint only returns a job belonging to the authenticated user.
5. The result includes exact notes for the current video, semantically related personal notes, and prerequisite/upcoming concepts from saved video analysis with matched personal notes and timestamps where available.
6. A synchronous `GET /api/knowledge/previous-context/?youtube_id=...` endpoint also exists.

## G. Maintenance / re-indexing

- `python manage.py index_notes` iterates through existing notes and rebuilds their knowledge chunks, reporting individual failures and exiting with a command error if any fail.
- Transcript and video-analysis indexing have dedicated services called by their corresponding API views; no separate scheduler/Celery system was found.

# 6. Backend Architecture

- **Framework and entry points:** Django project `config`, started through `backend/manage.py`; WSGI and ASGI callables are in `config/wsgi.py` and `config/asgi.py`.
- **Installed project apps:** `users`, `folders`, `videos`, `notes`, `questions`, and `knowledge`, in addition to Django admin/auth/session apps.
- **URL routing:** `config/urls.py` mounts:
  - `/admin/`
  - `/api/notes/` → `notes.urls`
  - `/api/videos/` → `videos.urls`
  - `/api/knowledge/` → `knowledge.urls`
- **Views/controllers:** DRF class-based API views in `notes/views.py`, `videos/views.py`, and `knowledge/views.py`. Note CRUD uses generic DRF views; transcript, analysis, RAG, and Previous Context use API views.
- **Serializers:** `NoteSerializer` validates version-1 block documents and note/video consistency. Video serializers expose video status and read-only analysis. Knowledge serializers validate question scopes, YouTube IDs, and response structures.
- **Services:**
  - `videos/services/youtube.py`: metadata extraction and ID validation.
  - `videos/services/transcript.py`: transcript selection, retrieval, and segment validation.
  - `videos/services/analysis_providers.py`: Gemini/Hugging Face structured analysis providers and provider manager.
  - `videos/services/analysis.py`: transcript validation, analysis orchestration, persistence and status updates.
  - `knowledge/services/embeddings.py`: lazy-loaded Qwen/PyTorch embedding adapter, batching, normalization and validation.
  - `knowledge/services/indexing.py`, `transcript_indexing.py`, `analysis_indexing.py`: create/replace source-specific knowledge chunks.
  - `knowledge/services/retrieval.py`: user/context ownership checks and cosine-distance ranking.
  - `knowledge/services/context.py`, `rag.py`, `generation.py`: context assembly and grounded answer generation.
  - `knowledge/services/previous_context.py`: exact note lookup, related-note similarity, and concept enrichment from analysis.
  - `previous_context_jobs.py` and `previous_context_events.py`: persisted job lifecycle and Kafka publication.
- **Authentication/middleware:** Standard Django middleware includes session/auth, CSRF, security, messages, and clickjacking protection. DRF defaults to `IsAuthenticated`, using development header authentication and session authentication. The development header authenticator does nothing when `DEBUG` is false.
- **Error handling:** Serializers raise DRF validation errors; not-found records produce 404s. Transcript/analysis services use specific exceptions and views map them to status responses. Note indexing errors roll back the transaction and return a gateway error. AI generation and retrieval have separate exception classes. Some optional transcript/analysis indexing failures are logged while the main fetch/analysis result remains available.
- **Background processing:** `knowledge/management/commands/run_previous_context_worker.py` is a Kafka consumer with manual offset commit and persisted job claiming. It is run explicitly as a Django management command. No Celery/RQ scheduler was found.
- **Unimplemented API surfaces:** `folders/views.py`, `questions/views.py`, and `users/views.py` are placeholders. Folder and Question models are not routed through `config/urls.py`. No registration/login API is implemented in the project routes.

# 7. Frontend Architecture

- **Framework:** React + TypeScript, built with Vite.
- **Chrome entry points:** `manifest.json` registers `background.js` as the Manifest V3 service worker and `content.js` for YouTube watch pages. Separate Vite configs bundle each script.
- **Content script:** `content.tsx` detects the active YouTube video and mounts `Sidebar` into a page-created root. It polls because YouTube navigation is an SPA.
- **Primary component:** `Sidebar.tsx` implements the application sidebar and its note, analysis, and AI workspaces. It includes rich note reading/editing, transcript/analysis actions, RAG source display, Previous Context, dark/light themes, dragging/minimizing, and timestamp navigation.
- **State management:** React component state/hooks; no Redux, Zustand, or other global state library is declared. API data is requested through runtime messages; theme/position are persisted in Chrome local storage.
- **API communication:** `ragApi.ts` defines payload/response types and validation. UI code sends runtime messages to `background.ts`; the background script calls the Django API at localhost. The development identity header is attached there.
- **Authentication UI:** No login/session management screen was found in the extension. The extension is wired to the backend's development-header authentication.
- **Forms and validation:** Note forms/editors maintain a versioned JSON block document; API-side `NoteSerializer` is authoritative for server validation. RAG scopes are constrained in TypeScript/API types, and Previous Context validates runtime response shapes before rendering.
- **Styling:** CSS files (`index.css`, `App.css`) plus component inline `CSSProperties` and theme color objects in `Sidebar.tsx`. Icons use `lucide-react`.
- **Scaffold note:** `main.tsx` mounts the generic Vite starter `App.tsx`. The actual extension UI is the sidebar injected by `content.tsx`; the README in `extension/` is unmodified template setup text.

# 8. Database Architecture

## Database and migrations

- **Configured database:** PostgreSQL. Docker Compose supplies PostgreSQL 17 with pgvector. Django model schema is maintained by migrations in each app.
- **Vector extension:** `knowledge/0002_knowledgechunk_embedding.py` installs the pgvector extension and adds a nullable 1024-dimensional vector field. Retrieval uses `CosineDistance`; no explicit approximate-nearest-neighbor vector index is declared in the inspected model/migrations.
- **Migrations:** Users has `0001`; folders has `0001` and `0002`; notes has `0001`–`0003`; questions has `0001` and `0002`; videos has `0001`–`0004`; knowledge has `0001`–`0006`. The latest note migration adds `document` JSON and makes legacy `content` optional; the latest knowledge migration adds Previous Context jobs.
- **Indexes/constraints:** Folder declares unique `(user, parent, name)`. Video has a unique `youtube_id`. ViewingSession declares unique `(user, video)`. VideoAnalysis is one-to-one with Video. KnowledgeChunk declares indexes on `user`, `(user,note)`, `(user,video)`, `(user,folder)`, and `(user,content_type)`. No additional explicit model indexes were found for the other tables.

## Models / tables

| Model/table | Fields and constraints | Relationships / behavior |
|---|---|---|
| `users.User` | Django `AbstractUser` fields; no project-specific fields. | Configured as `AUTH_USER_MODEL`. |
| `folders.Folder` | `name` (255), optional `description`, created/updated timestamps; unique `(user,parent,name)`; default ordering by name. | Belongs to user (cascade); optional parent folder (self-FK, cascade); notes/questions/chunks can reference folder. |
| `videos.Video` | Unique `youtube_id` (20); title (500), channel name/handle/ID, thumbnail URL, optional duration; transcript status/data/language/fetched timestamp; analysis status; created/updated timestamps. | Shared video record keyed by YouTube ID; not directly user-owned. Notes, viewing sessions, analysis and knowledge chunks reference it. |
| `videos.ViewingSession` | `last_position_seconds` (default 0), `last_watched_at`; unique `(user,video)`. | User and video FKs both cascade. |
| `videos.VideoAnalysis` | One-to-one video; summary; JSON detailed notes, topics, concepts, prerequisites, upcoming topics, key points, claims and questions; model/version; created/updated timestamps. | Cascades with video. |
| `notes.Note` | Title (500), versioned `document` JSON, legacy optional `content`, `note_type` (`VIDEO`/`STANDALONE`), optional `timestamp_seconds`, timestamps. | User FK cascades; optional folder is set null on delete; optional video cascades on delete. Ordered by most recently updated. |
| `questions.Question` | Question and optional blank answer text; created timestamp. | User FK cascades; optional video/folder FKs set null. No question API route is wired. |
| `knowledge.KnowledgeChunk` | Text content; `content_type` (`NOTE`, `NOTE_BLOCK`, `TRANSCRIPT_CHUNK`, `ANALYSIS_CHUNK`); `source_type` (`NOTE`, `VIDEO_TRANSCRIPT`, `VIDEO_ANALYSIS`); optional source block ID; chunk index; JSON metadata; nullable 1024-dimensional embedding; timestamps. | User FK cascades; optional note/video cascade on delete; optional folder set null. User/source-specific chunks support semantic search. |
| `knowledge.PreviousContextJob` | UUID primary key; YouTube ID; status (`PENDING`, `PROCESSING`, `READY`, `FAILED`); nullable JSON result and error; created/updated timestamps. | User FK cascades; optional video FK set null. |

## Relationship diagram

```text
User
 ├──< Folder ── parent/children self-reference
 ├──< Note >── Video (optional; deleting Video deletes linked Notes)
 │      └── optional Folder
 ├──< Question >── optional Video / optional Folder
 ├──< KnowledgeChunk >── optional Note / optional Video / optional Folder
 ├──< ViewingSession >── Video
 └──< PreviousContextJob >── optional Video

Video (unique youtube_id; global/shared record)
 ├── 0..1 VideoAnalysis
 ├──< Note
 ├──< ViewingSession
 ├──< KnowledgeChunk
 └──< PreviousContextJob
```

Video ownership is not a direct `Video.user` FK. Retrieval infers a user's association with a video through their notes/knowledge chunks; folder ownership is checked directly through `Folder.user`.

# 9. API Documentation

## General API behavior

- Base URL in extension code: `http://localhost:8000`.
- All routes below are mounted by `backend/config/urls.py`.
- DRF's configured default permission is `IsAuthenticated`; the extension currently uses the development-only `X-Dev-User` header. Authentication values/credentials are intentionally not included.
- JSON validation failures use DRF's 400 response format. Exact error detail can vary by serializer/view.
- `<youtube_id>` must be an 11-character YouTube ID for transcript, analysis, and Previous Context inputs. The video context URL uses a string path converter, and RAG `youtube_id` is only constrained to max length 20 by its serializer before database lookup.

## Videos

### `GET /api/videos/<youtube_id>/`

**Purpose:** Load global video state and the authenticated user's notes for that video.

**Authentication:** Required.

**Request:** No body.

**Response when a Video row is absent:**

```json
{
  "saved": false,
  "video": null,
  "notes": []
}
```

**Response when a Video row exists:** `saved: true`, serialized `video` (including transcript/analysis statuses and optional analysis), and the requesting user's serialized `notes`.

**Important behavior:** This GET does not create the video. **Implementation:** `videos.views.VideoContextView`.

### `POST /api/videos/<youtube_id>/transcript/`

**Purpose:** Fetch and persist transcript segments; attempt to index them for the authenticated user.

**Authentication:** Required.

**Request:** No required body fields; extension sends `{}`.

**Success response:** `youtube_id`, `transcript_status`, nullable `transcript` object (`language`, `segments`), and `transcript_fetched_at`. Each segment has `text`, `start`, and `duration`.

**Important errors:** 400 invalid YouTube ID; 404 transcript unavailable; 502 retrieval failure. On success, transcript-indexing errors are logged and do not suppress the transcript response.

**Implementation:** `videos.views.TranscriptView`; retrieval in `videos.services.transcript`; indexing in `knowledge.services.transcript_indexing`.

### `POST /api/videos/<youtube_id>/analyze/`

**Purpose:** Generate, save, and index structured analysis from a persisted transcript.

**Authentication:** Required.

**Request:** No required body fields; extension sends `{}`.

**Success response:** `{ "status": "READY", "video_id": "<youtube_id>", "analysis": { ... } }`. Analysis contains `summary`, `detailed_notes`, `topics`, `concepts`, `prerequisites`, `upcoming_topics`, `key_points`, `claims`, `questions`, model/version, and timestamps.

**Important errors:** 400 invalid YouTube ID; 404 video not found; 409 transcript not ready/unavailable; 502 analysis providers fail. Analysis indexing failure is logged while the stored analysis is returned.

**Implementation:** `videos.views.VideoAnalysisView`; orchestration in `videos.services.analysis`; providers in `videos.services.analysis_providers`; indexing in `knowledge.services.analysis_indexing`.

## Notes

### `GET /api/notes/`

**Purpose:** List the authenticated user's notes.

**Authentication:** Required.

**Request:** No body.

**Response:** DRF serialized note list with `id`, `title`, `document`, legacy `content`, `note_type`, `folder`, `video`, `timestamp_seconds`, `created_at`, and `updated_at`.

**Implementation:** `notes.views.NoteListCreateView`; serializer `notes.serializers.NoteSerializer`.

### `POST /api/notes/`

**Purpose:** Create a note directly through the general note API.

**Authentication:** Required.

**Request example:**

```json
{
  "title": "Key idea",
  "document": {
    "version": 1,
    "blocks": [
      {
        "id": "block-1",
        "type": "paragraph",
        "content": "A note paragraph."
      }
    ]
  },
  "content": "",
  "note_type": "STANDALONE",
  "folder": null,
  "video": null,
  "timestamp_seconds": null
}
```

`document` must be an object with version `1` and a `blocks` array; every block must be an object with non-empty `id`, `type`, and a `content` key. `VIDEO` notes require a video; `STANDALONE` notes cannot have a video or timestamp.

**Response:** Created serialized note.

**Important errors:** 400 serializer validation errors; note embedding/indexing failure maps to 502 and rolls back the create.

**Implementation:** `notes.views.NoteListCreateView`, `_save_and_index_note`.

### `POST /api/notes/video/`

**Purpose:** Create a video-linked note, resolving or creating the associated Video from YouTube metadata.

**Authentication:** Required.

**Request example:**

```json
{
  "youtube_id": "abcdefghijk",
  "title": "Video notes",
  "document": {
    "version": 1,
    "blocks": [
      {
        "id": "block-1",
        "type": "paragraph",
        "content": "A note tied to this video."
      }
    ]
  },
  "content": "",
  "note_type": "VIDEO",
  "folder": null,
  "timestamp_seconds": null
}
```

**Response:** `{ "video_created": boolean, "metadata_resolved": boolean, "video": { ... }, "note": { ... } }`.

**Important errors:** 400 missing/invalid YouTube ID or note validation; 502 note indexing failure. Metadata resolution failure has fallback metadata and is reported by `metadata_resolved: false`.

**Implementation:** `notes.views.VideoNoteCreateView`.

### `GET|PUT|PATCH|DELETE /api/notes/<pk>/`

**Purpose:** Retrieve, replace/update, or delete one of the authenticated user's notes.

**Authentication:** Required.

**Request:** GET/DELETE have no body; PUT/PATCH accept note serializer fields described above.

**Response:** GET/PUT/PATCH return the serialized note; DELETE returns 204 with no body.

**Important errors:** 404 for notes outside the user's queryset or nonexistent IDs; 400 validation; 502 if update indexing fails.

**Implementation:** `notes.views.NoteDetailView`.

## Knowledge / RAG

### `POST /api/knowledge/ask/`

**Purpose:** Retrieve scoped personal knowledge and return a grounded generated answer with citations/sources.

**Authentication:** Required.

**Request:**

```json
{
  "question": "What did I learn about this topic?",
  "scope": "CURRENT_VIDEO",
  "youtube_id": "abcdefghijk",
  "folder_id": null,
  "top_k": 5
}
```

`scope` accepts serializer choices `CURRENT_VIDEO`, `CURRENT_FOLDER`, `PERSONAL_KB`, or `COMBINED`. `youtube_id` is required for `CURRENT_VIDEO`; `folder_id` is required for `CURRENT_FOLDER`; `top_k` defaults to 5 and must be positive.

**Success response:**

```json
{
  "answer": "Answer grounded in the retrieved passages.",
  "sources": [
    {
      "chunk_id": 42,
      "content": "Retrieved source text",
      "distance": 0.12,
      "note_id": 7,
      "video_id": 3,
      "folder_id": null,
      "source_block_id": "block-1",
      "chunk_index": 0,
      "metadata": {
        "source_type": "NOTE"
      }
    }
  ]
}
```

Nullable source IDs and `source_block_id` can be null.

**Important errors:** 400 invalid input or retrieval failure; 404 missing video/folder; 502 answer-generation failure.

**Implementation:** `knowledge.views.KnowledgeAskView`; request and orchestration in `knowledge.services.rag`, retrieval in `knowledge.services.retrieval`, answer generation in `knowledge.services.generation`.

### `GET /api/knowledge/previous-context/?youtube_id=<11-char-id>`

**Purpose:** Compute the authenticated user's Previous Context synchronously.

**Authentication:** Required.

**Request:** Query parameter `youtube_id` matching `^[A-Za-z0-9_-]{11}$`.

**Success response shape:** `{ "video": { "id": number, "youtube_id": string }, "exact": [...], "related": [...], "concepts": { "prerequisites": [...], "upcoming": [...] } }`. Exact items contain note IDs/title/content; related items include chunk/note IDs, title/content, nullable video/folder IDs, distance, and source. Concepts include match flags/counts, reason/evidence, timestamps, and related personal notes.

**Important errors:** 400 invalid query; 404 video not found; 503 retrieval service failure.

**Implementation:** `knowledge.views.PreviousContextView`; computation in `knowledge.services.previous_context`.

### `POST /api/knowledge/previous-context/jobs/`

**Purpose:** Persist and enqueue asynchronous Previous Context computation.

**Authentication:** Required.

**Request:**

```json
{
  "youtube_id": "abcdefghijk"
}
```

**Success response (201):**

```json
{
  "job_id": "uuid",
  "status": "PENDING",
  "youtube_id": "abcdefghijk"
}
```

**Important behavior:** Job creation commits to PostgreSQL before Kafka publication. Publication failures are logged; the persisted job remains pending.

**Implementation:** `knowledge.views.PreviousContextJobCreateView`; job/event services in `knowledge.services.previous_context_jobs` and `knowledge.services.previous_context_events`.

### `GET /api/knowledge/previous-context/jobs/<job_id>/`

**Purpose:** Read a Previous Context job belonging to the authenticated user.

**Authentication:** Required.

**Request:** UUID path parameter.

**Response:** Always includes `job_id`, `status`, and `youtube_id`; includes `result` when `READY`, or `error` when `FAILED`.

**Important errors:** 404 if missing or owned by another user.

**Implementation:** `knowledge.views.PreviousContextJobStatusView`.

## Other route and functionality notes

- `GET /admin/` is the Django admin route.
- No folder CRUD, Question CRUD, or user registration/login API is mounted in `config/urls.py`; their model/app files should not be mistaken for implemented REST endpoints.
- The backend settings load `.env`, but the repository also contains local development settings and compose configuration. Do not copy secret, password, token, or `.env` values into documentation or source examples.
- The extension's backend base URL is hard-coded to localhost in `extension/src/background.ts`; production API configuration/deployment is **Not found in the repository**.
- Local development commands supported by the checked-in configuration:

```powershell
# Start PostgreSQL/pgvector and Kafka
docker compose up -d db kafka

# In backend\
.\.venv\Scripts\Activate.ps1
python manage.py migrate
python manage.py runserver

# In extension\
npm install
npm run build
npm run lint
```

The Python environment activation path above assumes the local `backend/.venv` directory exists; otherwise install `backend/requirements.txt` into the chosen Python environment. Django tests can be run from `backend\` with `python manage.py test`.
