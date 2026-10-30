import hashlib
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, List, Tuple

import chromadb
import fitz
import ollama
import streamlit as st
from chromadb.utils.embedding_functions import OllamaEmbeddingFunction
from langchain_community.document_loaders import PyMuPDFLoader
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import CrossEncoder

# Optional voice dependencies. Install them using the commands shown in the app.
try:
    from streamlit_mic_recorder import mic_recorder
except ImportError:
    mic_recorder = None

try:
    import speech_recognition as sr
except ImportError:
    sr = None

try:
    import pyttsx3
except ImportError:
    pyttsx3 = None


# ---------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------
APP_TITLE = "Offline Disaster Assistance"
BASE_DIR = Path(__file__).resolve().parent
KNOWLEDGE_DIR = BASE_DIR / "knowledge_base"
CHROMA_DIR = BASE_DIR / "demo-rag-chroma"

OLLAMA_URL = "http://localhost:11434"
LLM_MODEL = "llama3.2:3b"
EMBED_MODEL = "nomic-embed-text:latest"
RERANK_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"

TOPICS: Dict[str, str] = {
    "General disaster safety": "disaster_safety.pdf",
    "Crowd safety": "crowd_safety.pdf",
    "Earthquake rescue": "earthquake_rescue.pdf",
    "First aid and ambulance": "first_aid.pdf",
    "Flood rescue": "flood_rescue.pdf",
    "Flood risk mitigation": "flood_risk_mitigation.pdf",
}

st.set_page_config(
    page_title=APP_TITLE,
    page_icon="🆘",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown(
    """
    <style>
      .stApp {
        background: linear-gradient(145deg, #0b1220 0%, #111b2e 55%, #101827 100%);
      }
      [data-testid="stSidebar"] {
        background: #0b1322;
        border-right: 1px solid #26364d;
      }
      .hero {
        padding: 1.35rem 1.5rem;
        border-radius: 18px;
        margin-bottom: 1rem;
        background: linear-gradient(120deg, rgba(20,82,105,.75), rgba(38,55,93,.75));
        border: 1px solid rgba(148, 190, 220, .28);
      }
      .hero h1 { margin: 0; color: #f4f8ff; font-size: 2.1rem; }
      .hero p { margin: .45rem 0 0 0; color: #d4e4f5; }
      div[data-testid="stChatMessage"] {
        border: 1px solid rgba(148,163,184,.15);
        border-radius: 14px;
      }
      .stButton > button { border-radius: 10px; }
    </style>
    """,
    unsafe_allow_html=True,
)


# ---------------------------------------------------------------------
# Cached clients and models
# ---------------------------------------------------------------------
@st.cache_resource
def get_embedding_function():
    return OllamaEmbeddingFunction(
        url=f"{OLLAMA_URL}/api/embeddings",
        model_name=EMBED_MODEL,
    )


@st.cache_resource
def get_chroma_client():
    CHROMA_DIR.mkdir(parents=True, exist_ok=True)
    return chromadb.PersistentClient(path=str(CHROMA_DIR))


@st.cache_resource
def get_reranker():
    return CrossEncoder(RERANK_MODEL)


def collection_name_for(topic: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", topic.lower()).strip("_")
    return f"disaster_{slug}"[:60]


def file_fingerprint(path: Path) -> str:
    stat = path.stat()
    value = f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def get_collection(topic: str):
    return get_chroma_client().get_or_create_collection(
        name=collection_name_for(topic),
        embedding_function=get_embedding_function(),
        metadata={"topic": topic},
    )


# ---------------------------------------------------------------------
# PDF extraction: regular text first, OCR per page as fallback
# ---------------------------------------------------------------------
def extract_pdf_pages(pdf_path: Path) -> List[Document]:
    """Extract searchable PDF text and OCR pages that contain no usable text."""
    loaded_pages = PyMuPDFLoader(str(pdf_path)).load()
    pages_by_number = {
        int(doc.metadata.get("page", index)): doc
        for index, doc in enumerate(loaded_pages)
    }

    # Inspect each PDF page. Some PDFs mix text pages with scanned pages,
    # so OCR is applied only to pages with no selectable text.
    with fitz.open(str(pdf_path)) as pdf:
        output_pages: List[Document] = []

        for page_number, page in enumerate(pdf):
            existing = pages_by_number.get(page_number)
            text = existing.page_content.strip() if existing else ""

            if not text:
                try:
                    tessdata_dir = Path(
                     r"C:\Program Files\Tesseract-OCR\tessdata"
                    )

                    if not (tessdata_dir / "eng.traineddata").exists():
                     raise FileNotFoundError(
                        f"English OCR data not found in {tessdata_dir}. "
                      "Check your Tesseract installation."
                        )

                    os.environ["TESSDATA_PREFIX"] = str(tessdata_dir)

                    text_page = page.get_textpage_ocr(
                    language="eng",
                    dpi=200,
                    full=True,
                    tessdata=str(tessdata_dir),
                 )
                    text = page.get_text(textpage=text_page).strip()
                except Exception as exc:
                    raise RuntimeError(
                        "OCR could not read a scanned page. Make sure Tesseract OCR "
                        "is installed and available on PATH. On Windows, the usual "
                        r"executable location is C:\Program Files\Tesseract-OCR\tesseract.exe. "
                        f"Original error: {exc}"
                    ) from exc

            output_pages.append(
                Document(
                    page_content=text,
                    metadata={"page": page_number},
                )
            )

    return output_pages


def index_topic_pdf(topic: str, force_reindex: bool = False) -> Tuple[int, str]:
    """Load and index the PDF belonging to the selected topic."""
    filename = TOPICS[topic]
    pdf_path = KNOWLEDGE_DIR / filename

    if not pdf_path.is_file():
        raise FileNotFoundError(
            f"PDF not found: {pdf_path}\n"
            "Check that the filename in knowledge_base matches the app exactly."
        )

    collection = get_collection(topic)
    fingerprint = file_fingerprint(pdf_path)
    metadata = collection.metadata or {}

    if (
        not force_reindex
        and collection.count() > 0
        and metadata.get("file_fingerprint") == fingerprint
    ):
        return collection.count(), "already indexed"

    pages = extract_pdf_pages(pdf_path)
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=700,
        chunk_overlap=120,
        separators=["\n\n", "\n", ". ", "? ", "! ", " ", ""],
    )
    chunks = [
        doc for doc in splitter.split_documents(pages)
        if doc.page_content and doc.page_content.strip()
    ]

    if not chunks:
        raise ValueError(
            f"No readable text could be extracted from {filename}. "
            "It may be protected, blank, or require a different OCR language."
        )

    # Remove stale chunks before indexing the current version.
    if collection.count() > 0:
        old = collection.get()
        old_ids = old.get("ids", [])
        if old_ids:
            collection.delete(ids=old_ids)

    ids: List[str] = []
    texts: List[str] = []
    metadatas: List[dict] = []

    for index, doc in enumerate(chunks):
        # PyMuPDF uses zero-based page numbers; display page numbers as one-based.
        page_number = int(doc.metadata.get("page", 0)) + 1
        ids.append(f"{fingerprint}_{index}")
        texts.append(doc.page_content)
        metadatas.append(
            {
                "topic": topic,
                "source_file": filename,
                "page": page_number,
                "chunk": index,
                "file_fingerprint": fingerprint,
            }
        )

    batch_size = 48
    for start in range(0, len(ids), batch_size):
        collection.add(
            ids=ids[start:start + batch_size],
            documents=texts[start:start + batch_size],
            metadatas=metadatas[start:start + batch_size],
        )

    collection.modify(
        metadata={"topic": topic, "file_fingerprint": fingerprint}
    )
    return len(chunks), "indexed"


# ---------------------------------------------------------------------
# Retrieval, reranking and grounded answer generation
# ---------------------------------------------------------------------
def retrieve_context(topic: str, question: str, n_results: int = 8) -> List[dict]:
    collection = get_collection(topic)

    if collection.count() == 0:
        index_topic_pdf(topic)

    total = collection.count()
    if total == 0:
        return []

    result = collection.query(
        query_texts=[question],
        n_results=min(n_results, total),
        include=["documents", "metadatas", "distances"],
    )

    docs = result.get("documents", [[]])[0] or []
    metadatas = result.get("metadatas", [[]])[0] or []
    if not docs:
        return []

    reranker = get_reranker()
    ranked = reranker.rank(question, docs, top_k=min(4, len(docs)))

    context: List[dict] = []
    for item in ranked:
        index = int(item["corpus_id"])
        metadata = metadatas[index] if index < len(metadatas) else {}
        context.append(
            {
                "text": docs[index],
                "source_file": metadata.get("source_file", TOPICS[topic]),
                "page": metadata.get("page", "?"),
                "score": float(item.get("score", 0.0)),
            }
        )
    return context


def make_prompt(topic: str, question: str, context: List[dict]) -> str:
    source_text = "\n\n".join(
        f"[Source: {item['source_file']}, page {item['page']}]\n{item['text']}"
        for item in context
    )

    return f"""You are an offline disaster-assistance information assistant.
Selected topic: {topic}

Rules:
- Answer from the source excerpts below. Do not invent unsupported facts.
- If the excerpts do not answer the question, clearly say the local documents do not provide enough information.
- Give short, calm, practical steps.
- Never invent emergency numbers, shelter locations, live alerts, or real-time incident updates.
- For immediate danger, advise contacting local emergency services when available.
- You are not a substitute for emergency responders or medical professionals.
- For first aid, advise emergency medical help for serious or life-threatening symptoms.
- Finish with a short source note listing the document and page numbers used.

SOURCE EXCERPTS:
{source_text}

USER QUESTION:
{question}

Answer clearly. Use numbered steps where helpful."""


def generate_answer(topic: str, question: str, context: List[dict]):
    prompt = make_prompt(topic, question, context)
    response_stream = ollama.chat(
        model=LLM_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a careful, source-grounded disaster information assistant. "
                    "Be concise and do not fabricate facts."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        stream=True,
        options={"temperature": 0.2},
    )

    for part in response_stream:
        text = part.get("message", {}).get("content", "")
        if text:
            yield text


# ---------------------------------------------------------------------
# Voice input and output
# ---------------------------------------------------------------------
def transcribe_audio(audio_bytes: bytes) -> str:
    """Convert browser audio to PCM WAV, then transcribe it."""
    if sr is None:
        raise RuntimeError(
            "SpeechRecognition is not installed. Run: "
            "python -m pip install SpeechRecognition"
        )

    try:
        import imageio_ffmpeg
    except ImportError as exc:
        raise RuntimeError(
            "Audio conversion package missing. Run: "
            "python -m pip install imageio-ffmpeg"
        ) from exc

    input_path = None
    output_path = None

    try:
        # The recorder may return WebM/Opus; FFmpeg detects the actual content.
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as source:
            source.write(audio_bytes)
            input_path = source.name

        # Use a fresh path so FFmpeg creates a valid WAV file.
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as target:
            output_path = target.name

        result = subprocess.run(
            [
                imageio_ffmpeg.get_ffmpeg_exe(),
                "-y",
                "-i", input_path,
                "-vn",
                "-ac", "1",
                "-ar", "16000",
                "-c:a", "pcm_s16le",
                "-f", "wav",
                output_path,
            ],
            capture_output=True,
            text=True,
            timeout=90,
        )

        if result.returncode != 0:
            raise RuntimeError(
                "Audio conversion failed. Try recording again. FFmpeg says: "
                + result.stderr[-900:]
            )

        recognizer = sr.Recognizer()
        with sr.AudioFile(output_path) as audio_source:
            audio = recognizer.record(audio_source)

        # This service needs an internet connection.
        return recognizer.recognize_google(audio)

    except sr.UnknownValueError as exc:
        raise RuntimeError(
            "I couldn't understand that recording. Please speak clearly and try again."
        ) from exc
    except sr.RequestError as exc:
        raise RuntimeError(
            f"Online speech recognition is unavailable: {exc}"
        ) from exc
    finally:
        for path in (input_path, output_path):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass


def speak_text_to_audio(text: str) -> bytes:
    """Generate a WAV response using the computer's locally installed voice."""
    if pyttsx3 is None:
        raise RuntimeError(
            "pyttsx3 is not installed. Run: python -m pip install pyttsx3"
        )

    audio_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp:
            audio_path = temp.name

        # Remove the empty temporary file before asking pyttsx3 to create it.
        if os.path.exists(audio_path):
            os.remove(audio_path)

        engine = pyttsx3.init()
        engine.setProperty("rate", 170)
        engine.save_to_file(text, audio_path)
        engine.runAndWait()
        engine.stop()

        if not os.path.exists(audio_path) or os.path.getsize(audio_path) == 0:
            raise RuntimeError(
                "The local speech engine did not create an audio file. "
                "Check that Windows has a text-to-speech voice installed."
            )

        with open(audio_path, "rb") as audio_file:
            return audio_file.read()
    finally:
        if audio_path and os.path.exists(audio_path):
            try:
                os.remove(audio_path)
            except OSError:
                pass


# ---------------------------------------------------------------------
# Sidebar
# ---------------------------------------------------------------------
with st.sidebar:
    st.markdown("## 🆘 Disaster Help")
    st.caption("Local PDFs + local Ollama model")

    topic = st.selectbox("Choose a topic", list(TOPICS.keys()))
    selected_pdf = TOPICS[topic]
    pdf_path = KNOWLEDGE_DIR / selected_pdf

    st.markdown(f"**Knowledge file:** `{selected_pdf}`")
    if pdf_path.is_file():
        st.success(f"PDF found · {pdf_path.stat().st_size / (1024 * 1024):.1f} MB")
    else:
        st.error(f"PDF missing: `{pdf_path}`")

    st.divider()
    if st.button("📚 Index / refresh this topic", use_container_width=True):
        try:
            with st.spinner("Extracting PDF text and indexing chunks..."):
                count, status = index_topic_pdf(topic, force_reindex=True)
            st.success(f"{status.capitalize()}: {count} text chunks")
        except Exception as exc:
            st.error(f"Could not index PDF: {exc}")

    if st.button("🧹 Clear chat", use_container_width=True):
        st.session_state.messages = []
        st.rerun()

    st.divider()
    st.markdown("### 🔊 Voice")
    voice_enabled = st.toggle("Speak assistant answers", value=True)
    st.caption(
        "Speech playback uses a local Windows voice. Microphone transcription in this "
        "version uses Google's online speech recognition."
    )


# ---------------------------------------------------------------------
# Main UI
# ---------------------------------------------------------------------
st.markdown(
    """
    <div class="hero">
      <h1>🆘 Offline Disaster Assistance</h1>
      <p>Ask questions about preparedness, rescue guidance, disaster safety and first aid.
      Answers are grounded in the PDF selected from your local knowledge base.</p>
    </div>
    """,
    unsafe_allow_html=True,
)

col1, col2, col3 = st.columns(3)
with col1:
    st.metric("Knowledge topics", len(TOPICS))
with col2:
    st.metric("Selected topic", topic)
with col3:
    st.metric("Language model", LLM_MODEL)

st.info(
    "Prototype limitation: this app does not provide live emergency alerts, GPS-based rescue "
    "dispatch, or verified real-time shelter/road information. In an immediate emergency, "
    "contact local emergency services."
)

# Automatically index a selected PDF if it has not been indexed or has changed.
if pdf_path.is_file():
    try:
        collection = get_collection(topic)
        current_fingerprint = file_fingerprint(pdf_path)
        collection_metadata = collection.metadata or {}

        if (
            collection.count() == 0
            or collection_metadata.get("file_fingerprint") != current_fingerprint
        ):
            with st.spinner(f"Preparing {selected_pdf} for search (OCR may take a while)..."):
                chunk_count, status = index_topic_pdf(topic)
            st.toast(f"{topic}: {chunk_count} chunks {status}.")
    except Exception as exc:
        st.error(
            "Could not prepare the selected PDF. Confirm that Ollama is running, the required "
            "models are installed, and Tesseract OCR is installed if this PDF is scanned.\n\n"
            f"Details: {exc}"
        )

if "messages" not in st.session_state:
    st.session_state.messages = []

# Render previous chat turns.
for message in st.session_state.messages:
    with st.chat_message(message["role"]):
        st.markdown(message["content"])
        if message.get("sources"):
            with st.expander("Sources used"):
                for source in message["sources"]:
                    st.write(f"- `{source['source_file']}`, page {source['page']}")
        if message.get("audio") and message["role"] == "assistant":
            st.audio(message["audio"], format="audio/wav")


# Microphone input
voice_question = ""
if mic_recorder is not None:
    recording = mic_recorder(
        start_prompt="🎙️ Record a question",
        stop_prompt="⏹️ Stop recording",
        just_once=True,
        use_container_width=True,
        key=f"mic_recorder_{topic}",
    )
    if recording and recording.get("bytes"):
        try:
            with st.spinner("Converting and transcribing your recording..."):
                voice_question = transcribe_audio(recording["bytes"])
            st.success(f"Recognized question: {voice_question}")
        except Exception as exc:
            st.warning(f"Voice transcription failed: {exc}")
else:
    st.caption(
        "Microphone control unavailable. Install `streamlit-mic-recorder`, "
        "`SpeechRecognition`, and `imageio-ffmpeg`."
    )

typed_question = st.chat_input(f"Ask about {topic.lower()}...")
question = typed_question or voice_question

if question:
    st.session_state.messages.append({"role": "user", "content": question})

    with st.chat_message("user"):
        st.markdown(question)

    with st.chat_message("assistant"):
        try:
            with st.spinner("Searching the selected PDF and generating an answer..."):
                retrieved = retrieve_context(topic, question)

                if not retrieved:
                    answer = (
                        "I couldn't find relevant information in the selected PDF. "
                        "Try rephrasing your question or choosing another topic."
                    )
                    st.markdown(answer)
                else:
                    answer = st.write_stream(
                        generate_answer(topic, question, retrieved)
                    )

            sources = []
            seen_sources = set()
            for item in retrieved:
                key = (item["source_file"], item["page"])
                if key not in seen_sources:
                    seen_sources.add(key)
                    sources.append(
                        {"source_file": item["source_file"], "page": item["page"]}
                    )

            with st.expander("Sources used"):
                for source in sources:
                    st.write(f"- `{source['source_file']}`, page {source['page']}")

            audio_bytes = None
            if voice_enabled and answer:
                try:
                    with st.spinner("Generating spoken response..."):
                        audio_bytes = speak_text_to_audio(answer)
                    st.audio(audio_bytes, format="audio/wav")
                except Exception as exc:
                    st.warning(f"Text-to-speech failed: {exc}")

            st.session_state.messages.append(
                {
                    "role": "assistant",
                    "content": answer,
                    "sources": sources,
                    "audio": audio_bytes,
                }
            )

        except Exception as exc:
            error_message = (
                f"Something went wrong: {exc}\n\n"
                "Check that Ollama is running, the required models are installed, and the "
                "selected PDF exists. If the PDF is scanned, make sure Tesseract OCR is installed."
            )
            st.error(error_message)
            st.session_state.messages.append(
                {
                    "role": "assistant",
                    "content": error_message,
                    "sources": [],
                }
            )


# ---------------------------------------------------------------------
# Setup notes
# ---------------------------------------------------------------------
with st.expander("🛠️ Setup and troubleshooting"):
    st.markdown(
        f"""
**Required local Ollama models**

```powershell
ollama pull {LLM_MODEL}
ollama pull {EMBED_MODEL}
```

**Install Python dependencies** in the activated `.venv`:

```powershell
python -m pip install streamlit chromadb ollama sentence-transformers pymupdf langchain-community langchain-text-splitters langchain-core imageio-ffmpeg streamlit-mic-recorder SpeechRecognition pyttsx3
```

**OCR requirement for scanned PDFs**

Install Tesseract OCR on Windows. The usual executable path is:

`C:\\Program Files\\Tesseract-OCR\\tesseract.exe`

If Tesseract is installed but not on PATH, add its folder to PATH and restart the terminal.

**Privacy/offline note:** PDF extraction, vector search, reranking, and answer generation run locally when the Ollama models are installed. Microphone transcription currently uses an online Google service. Voice playback is generated locally.
"""
    )
