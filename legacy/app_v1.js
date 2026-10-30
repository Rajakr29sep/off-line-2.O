const topicSelect = document.getElementById("topicSelect");
const selectedFile = document.getElementById("selectedFile");
const pdfStatus = document.getElementById("pdfStatus");
const topicHeading = document.getElementById("topicHeading");
const topicDescription = document.getElementById("topicDescription");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const questionInput = document.getElementById("questionInput");
const sendButton = document.getElementById("sendButton");
const micButton = document.getElementById("micButton");
const voiceToggle = document.getElementById("voiceToggle");
const voiceInputToggle = document.getElementById("voiceInputToggle");
const toast = document.getElementById("toast");
const connectionStatus = document.getElementById("connectionStatus");
const voiceHint = document.getElementById("voiceHint");

let busy = false;
let recognition = null;
let currentTopic = topicSelect.value;
const topicInfo = new Map((window.RESQ_TOPICS || []).map((item) => [item.label, item]));

function iconRefresh() {
  if (window.lucide) window.lucide.createIcons();
}
function showToast(message, timeout = 3500) {
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), timeout);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}
function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  sendButton.innerHTML = value
    ? '<span>Working…</span><i data-lucide="loader-circle"></i>'
    : '<span>Send question</span><i data-lucide="arrow-up"></i>';
  iconRefresh();
}
function scrollChat() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function removeWelcome() {
  const welcome = document.getElementById("welcomeCard");
  if (welcome) welcome.remove();
}
function addUserMessage(text) {
  removeWelcome();
  const node = document.createElement("div");
  node.className = "message-row user";
  node.innerHTML = `
    <div class="message-avatar"><i data-lucide="user-round"></i></div>
    <div class="message-content"><div class="message-meta">YOU · NOW</div>
      <div class="message-bubble">${escapeHtml(text)}</div></div>`;
  chatMessages.appendChild(node);
  iconRefresh();
  scrollChat();
}
function addTyping() {
  const node = document.createElement("div");
  node.className = "message-row";
  node.id = "typingIndicator";
  node.innerHTML = `
    <div class="message-avatar"><i data-lucide="shield-check"></i></div>
    <div class="message-content"><div class="message-meta">RESQ ASSISTANT</div>
      <div class="message-bubble"><div class="typing"><span></span><span></span><span></span> Searching documents and preparing guidance…</div></div></div>`;
  chatMessages.appendChild(node);
  iconRefresh();
  scrollChat();
}
function removeTyping() {
  const node = document.getElementById("typingIndicator");
  if (node) node.remove();
}
function speak(text) {
  if (!voiceToggle.checked || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.96;
  utterance.pitch = 1;
  const voices = window.speechSynthesis.getVoices();
  const englishVoice = voices.find((voice) => /^en(-|_)/i.test(voice.lang));
  if (englishVoice) utterance.voice = englishVoice;
  window.speechSynthesis.speak(utterance);
}
function addAssistantMessage(answer, sources = []) {
  const sourceHtml = sources.length
    ? `<details class="sources"><summary>Sources used (${sources.length})</summary><ul>${sources.map((source) =>
        `<li>${escapeHtml(source.source_file)}, page ${escapeHtml(source.page)}</li>`).join("")}</ul></details>`
    : "";
  const node = document.createElement("div");
  node.className = "message-row";
  node.innerHTML = `
    <div class="message-avatar"><i data-lucide="shield-check"></i></div>
    <div class="message-content"><div class="message-meta">RESQ ASSISTANT · SOURCE-GROUNDED</div>
      <div class="message-bubble">${escapeHtml(answer)}</div>${sourceHtml}
      <div class="message-tools"><button type="button" class="speak-button"><i data-lucide="volume-2"></i> Speak</button><button type="button" class="copy-button"><i data-lucide="copy"></i> Copy</button></div>
    </div>`;
  node.querySelector(".speak-button").addEventListener("click", () => {
    if (!("speechSynthesis" in window)) return showToast("Speech synthesis is not supported in this browser.");
    voiceToggle.checked = true;
    speak(answer);
  });
  node.querySelector(".copy-button").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(answer); showToast("Answer copied."); }
    catch { showToast("Could not copy automatically. Select and copy the answer."); }
  });
  chatMessages.appendChild(node);
  iconRefresh();
  scrollChat();
  speak(answer);
}
async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    if (response.ok && data.python?.status === "ok") {
      connectionStatus.classList.add("connected");
      connectionStatus.innerHTML = '<span class="status-dot"></span> Local AI connected';
    } else {
      connectionStatus.classList.remove("connected");
      connectionStatus.innerHTML = '<span class="status-dot"></span> Python service offline';
    }
  } catch {
    connectionStatus.classList.remove("connected");
    connectionStatus.innerHTML = '<span class="status-dot"></span> Service unavailable';
  }
}
function updateTopic() {
  currentTopic = topicSelect.value;
  const info = topicInfo.get(currentTopic);
  selectedFile.textContent = info?.file || "PDF not mapped";
  topicHeading.textContent = currentTopic;
  topicDescription.textContent = info?.description || "Ask questions grounded in the selected document.";
  pdfStatus.innerHTML = '<span class="status-dot warn"></span> Ready to index when selected';
  showToast(`Topic changed to ${currentTopic}.`);
}
topicSelect.addEventListener("change", updateTopic);

document.getElementById("indexButton").addEventListener("click", async () => {
  const info = topicInfo.get(currentTopic);
  if (!info) return showToast("No PDF is mapped to this topic.");
  pdfStatus.innerHTML = '<span class="status-dot warn"></span> Indexing document…';
  showToast("Indexing started. Scanned PDFs may take a few minutes.", 6000);
  try {
    const response = await fetch("/api/index", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: currentTopic, force_reindex: true })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Indexing failed");
    pdfStatus.innerHTML = `<span class="status-dot"></span> Indexed · ${data.chunks} chunks`;
    showToast(`${currentTopic} indexed successfully.`);
  } catch (error) {
    pdfStatus.innerHTML = '<span class="status-dot warn"></span> Indexing failed';
    showToast(error.message, 6000);
  }
});

async function sendQuestion(text) {
  const question = String(text || "").trim();
  if (!question || busy) return;
  addUserMessage(question);
  questionInput.value = "";
  questionInput.style.height = "auto";
  setBusy(true);
  addTyping();
  try {
    const response = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: currentTopic, question })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The assistant request failed.");
    removeTyping();
    addAssistantMessage(data.answer, data.sources || []);
  } catch (error) {
    removeTyping();
    addAssistantMessage(`I couldn't complete that request.\n\n${error.message}\n\nCheck that the Python service, Ollama, and required models are running.`);
  } finally {
    setBusy(false);
    questionInput.focus();
  }
}
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendQuestion(questionInput.value);
});
questionInput.addEventListener("input", () => {
  questionInput.style.height = "auto";
  questionInput.style.height = `${Math.min(questionInput.scrollHeight, 140)}px`;
});
questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});
document.getElementById("focusChat").addEventListener("click", () => questionInput.focus());
document.getElementById("clearChat").addEventListener("click", () => {
  window.speechSynthesis?.cancel();
  chatMessages.innerHTML = "";
  chatMessages.innerHTML = `<div class="welcome-card" id="welcomeCard"><div class="welcome-icon"><i data-lucide="hand-heart"></i></div><h3>How can I help you prepare?</h3><p>Select a topic on the left and ask a question. Answers use your local PDF knowledge base.</p><div class="suggestion-list"><button class="suggestion" data-question="What are the most important safety precautions?"><i data-lucide="shield-alert"></i><span>What are the most important safety precautions?</span><i data-lucide="arrow-up-right"></i></button><button class="suggestion" data-question="What should I do first in an emergency?"><i data-lucide="list-check"></i><span>What should I do first in an emergency?</span><i data-lucide="arrow-up-right"></i></button><button class="suggestion" data-question="Summarize the key guidance in this document."><i data-lucide="file-search"></i><span>Summarize this document</span><i data-lucide="arrow-up-right"></i></button></div></div>`;
  iconRefresh();
  bindSuggestions();
  showToast("Conversation cleared.");
});
function bindSuggestions() {
  document.querySelectorAll(".suggestion").forEach((button) => {
    button.addEventListener("click", () => sendQuestion(button.dataset.question));
  });
}
bindSuggestions();

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micButton.disabled = true;
    micButton.title = "Voice input is not supported by this browser. Try Chrome or Edge.";
    voiceHint.textContent = "Voice input works best in Chrome or Edge";
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = "en-IN";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    micButton.classList.add("recording");
    micButton.innerHTML = '<i data-lucide="audio-lines"></i>';
    voiceHint.textContent = "Listening… click the microphone to stop";
    iconRefresh();
  };
  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript || "";
    questionInput.value = transcript;
    questionInput.dispatchEvent(new Event("input"));
    voiceHint.textContent = transcript ? `Recognized: “${transcript}”` : "No speech recognized";
    if (transcript) sendQuestion(transcript);
  };
  recognition.onerror = (event) => {
    voiceHint.textContent = `Voice input error: ${event.error}`;
    showToast(`Voice input error: ${event.error}`);
  };
  recognition.onend = () => {
    micButton.classList.remove("recording");
    micButton.innerHTML = '<i data-lucide="mic"></i>';
    iconRefresh();
  };
}
micButton.addEventListener("click", () => {
  if (!voiceInputToggle.checked) return showToast("Enable Voice input in the sidebar first.");
  if (!recognition) return showToast("Voice recognition is not supported. Try Chrome or Edge.");
  try {
    if (micButton.classList.contains("recording")) recognition.stop();
    else recognition.start();
  } catch (error) {
    showToast(`Could not start microphone: ${error.message}`);
  }
});
voiceToggle.addEventListener("change", () => {
  if (!voiceToggle.checked) window.speechSynthesis?.cancel();
});
setupSpeechRecognition();
checkHealth();
updateTopic();
iconRefresh();
