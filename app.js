
const $ = (id) => document.getElementById(id);

const STORAGE_KEY = "longtext-vocab-book-v3";
const OLD_STORAGE_KEY = "longtext-vocab-book-v2";

let selectedImage = null;
let words = loadBook();

let importedWords = [];
let importedIndex = 0;
let importedHistory = [];
let currentDeck = "all";
let currentBookFilter = "all";
let currentCardIndex = 0;
let isFlipped = false;
// 直前に選択した分類
let lastClassification = null;
let classificationTimer = null;

// 仕分け取り消し用
let classifyHistory = [];
// 今回の学習で仕分け済みの単語
let classifiedThisSession = new Set();

// 今回の学習開始時の単語数
let sessionTotal = 0;

// スワイプ操作用
let touchStartX = 0;
let touchStartY = 0;
let isPointerDown = false;
let ignoreNextCardClick = false;

// ------------------------------
// データ保存・読み込み
// ------------------------------

function loadBook() {
  try {
    const current = localStorage.getItem(STORAGE_KEY);

    if (current) {
      return JSON.parse(current);
    }

    const old = JSON.parse(
      localStorage.getItem(OLD_STORAGE_KEY) || "[]"
    );

    const migrated = old.map(word => ({
      ...word,
      status: word.status || "unknown"
    }));

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(migrated)
    );

    return migrated;
  } catch {
    return [];
  }
}

function saveBook() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(words)
  );

  renderBook();
  renderStudyCard();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function findWordIndex(entry) {
  return words.findIndex(w =>
    w.word.toLowerCase() === entry.word.toLowerCase() &&
    Boolean(w.phrase) === Boolean(entry.phrase)
  );
}

// 品詞ごとの色分け
function getPosClass(pos) {
  const value = String(pos || "品詞不明");

  if (value.includes("熟語")) return "pos-phrase";
  if (value.includes("固有名詞")) return "pos-proper";
  if (value.includes("助動詞")) return "pos-auxiliary";
  if (value.includes("名詞")) return "pos-noun";
  if (value.includes("動詞")) return "pos-verb";
  if (value.includes("形容詞")) return "pos-adjective";
  if (value.includes("副詞")) return "pos-adverb";
  if (value.includes("前置詞")) return "pos-preposition";
  if (value.includes("接続詞")) return "pos-conjunction";
  if (value.includes("代名詞")) return "pos-pronoun";
  if (value.includes("冠詞")) return "pos-article";

  return "pos-other";
}

function posTag(entry) {
  return `<span class="tag pos-tag ${getPosClass(entry.pos)}">${escapeHtml(entry.pos)}</span>`;
}

// ------------------------------
// 画面切り替え
// ------------------------------

document.querySelectorAll(".nav-button").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-button").forEach(b => {
      b.classList.remove("active");
    });

    button.classList.add("active");

    document.querySelectorAll(".page-section").forEach(section => {
      section.classList.add("hidden");
    });

    $(button.dataset.target).classList.remove("hidden");

    // 学習画面ではヘッダーなどを隠す
    document.body.classList.toggle(
      "study-mode",
      button.dataset.target === "studySection"
    );

    if (button.dataset.target === "studySection") {
      renderStudyCard();
    }

    if (button.dataset.target === "bookSection") {
      renderBook();
    }
  });
});

// ------------------------------
// 画像選択・プレビュー
// ------------------------------

$("imageInput").addEventListener("change", event => {
  const file = event.target.files?.[0];

  if (!file) return;

  if (!file.type.startsWith("image/")) {
    alert("画像ファイルを選択してください。");
    return;
  }

  selectedImage = file;

  const reader = new FileReader();

  reader.onload = () => {
    $("preview").src = reader.result;
    $("preview").classList.remove("hidden");
  };

  reader.readAsDataURL(file);
});

// ------------------------------
// ChatGPT用プロンプト作成
// ------------------------------

function buildPrompt() {
  const text = $("sourceText").value.trim();

  if (!selectedImage && !text) {
    alert("写真を選ぶか、英文を貼り付けてください。");
    return;
  }

  const sourceInstruction = text
    ? `

【英文テキスト】
${text}

画像と英文の両方がある場合は、英文テキストを優先し、画像で補ってください。`
    : `

画像内の英文を読み取ってください。`;

  const prompt = `あなたは高校英語の語彙学習を支援するアシスタントです。添付された英文画像${text ? "および下記英文" : ""}から、語彙データを作成してください。

【最重要ルール】
1. 英文に現れる単語を原則すべて抽出してください。簡単そうな語も省略しないでください。冠詞・前置詞・代名詞・助動詞・接続詞・be動詞も対象です。
2. 同じ見出し語は1件にまとめ、本文中の出現回数 count を数えてください。
3. 活用形・複数形・比較級などは原形 word にまとめ、実際に現れた形を forms 配列に入れてください。
4. 日本語の意味は、この英文での文脈に合うものを優先してください。品詞 pos も付けてください。
5. 熟語・句動詞・複数語で意味を持つ表現は phrases に入れてください。単語の抽出も省略しないでください。
6. 人名・地名・組織名などの固有名詞も原則抽出し、pos を「固有名詞」としてください。
7. 画像の文字が不鮮明で読み取れない場合、勝手に推測して確定しないでください。uncertain を true にしてください。
8. 文脈から判断できない意味は無理に断定せず、uncertain を true にしてください。
9. 語彙の重複をまとめる際も、本文に登場した全ての語の種類を落とさないようにしてください。
10. JSON以外の説明文・Markdown・コードフェンスは一切出力しないでください。

【出力形式】
{
  "words": [
    {
      "word": "原形の英単語",
      "meaning": "日本語の意味",
      "pos": "品詞",
      "count": 2,
      "forms": ["本文に出た形"],
      "uncertain": false
    }
  ],
  "phrases": [
    {
      "word": "熟語・表現",
      "meaning": "日本語の意味",
      "count": 1,
      "uncertain": false
    }
  ]
}

count は本文中の出現回数です。forms は本文に出た形を列挙してください。該当するものがない場合も空配列にしてください。読み取り可能な範囲をできるだけ網羅し、JSONとして正しく出力してください。${sourceInstruction}`;

  $("prompt").value = prompt;
  $("prompt").focus();

  $("prompt").scrollIntoView({
    behavior: "smooth",
    block: "center"
  });
}

$("makePrompt").addEventListener("click", buildPrompt);

// ------------------------------
// プロンプトのコピー
// ------------------------------

$("copyPrompt").addEventListener("click", async () => {
  const value = $("prompt").value;

  if (!value) {
    alert("先にプロンプトを作成してください。");
    return;
  }

  try {
    await navigator.clipboard.writeText(value);

    $("copyPrompt").textContent = "コピーしました ✓";

    setTimeout(() => {
      $("copyPrompt").textContent = "プロンプトをコピー";
    }, 1600);

  } catch {
    $("prompt").focus();
    $("prompt").select();

    alert(
      "自動コピーできませんでした。選択された文章を手動でコピーしてください。"
    );
  }
});

// ------------------------------
// JSONの取り込み
// ------------------------------

function parseJson(raw) {
  let cleaned = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return JSON.parse(
      cleaned.slice(start, end + 1)
    );
  }

  throw new Error(
    "JSONを読み取れませんでした。JSON部分だけを貼り付けてください。"
  );
}

function normalizeEntry(item, isPhrase = false) {
  if (
    !item ||
    typeof item !== "object" ||
    !String(item.word || "").trim()
  ) {
    return null;
  }

  return {
    word: String(item.word).trim(),
    meaning: String(item.meaning || "意味未設定"),
    pos: isPhrase
      ? "熟語・表現"
      : String(item.pos || "品詞不明"),
    count: Number.isFinite(Number(item.count))
      ? Number(item.count)
      : 1,
    forms: Array.isArray(item.forms)
      ? item.forms.map(String)
      : [],
    uncertain: Boolean(item.uncertain),
    phrase: isPhrase
  };
}

$("importJson").addEventListener("click", () => {
  const message = $("importMessage");
  message.className = "message";

  try {
    const data = parseJson($("jsonInput").value);

    if (
      !Array.isArray(data.words) &&
      !Array.isArray(data.phrases)
    ) {
      throw new Error(
        'JSONに "words" または "phrases" の配列がありません。'
      );
    }

    importedWords = [
      ...(data.words || []).map(item =>
        normalizeEntry(item, false)
      ),
      ...(data.phrases || []).map(item =>
        normalizeEntry(item, true)
      )
    ].filter(Boolean);

    if (!importedWords.length) {
      throw new Error("取り込める単語がありませんでした。");
    }
    importedIndex = 0;
    importedHistory = [];
    renderImportedWords();
   
    message.textContent =
      `${importedWords.length}件の単語を読み込みました。わかる・わからないを判定してください。`;

    message.className = "message success";

    $("importedResults").scrollIntoView({
      behavior: "smooth",
      block: "start"
    });

  } catch (error) {
    message.textContent =
      error.message || "取り込みに失敗しました。";

    message.className = "message error";
  }
});

// ------------------------------
// 読み込んだ単語の仕分け
// ------------------------------

// ------------------------------
// 読み込んだ単語の仕分け（1語ずつ表示）
// ------------------------------
function selectImported(entry, status, card) {
  const buttons = card.querySelectorAll("button");

  // 連続クリックを防止
  buttons.forEach(button => {
    button.disabled = true;
  });

  // 選択したボタンを強調
  const selectedButton = card.querySelector(
    status === "known"
      ? ".known-button"
      : ".unknown-button"
  );

  selectedButton.classList.add("selected");

  // カード全体の色を変更
  card.classList.add(
    status === "known"
      ? "selected-known"
      : "selected-unknown"
  );

  // 色を見せてから次の単語へ
  setTimeout(() => {
    classifyImported(entry, status);
  }, 1000);
}
function classifyImported(entry, status) {
  const index = findWordIndex(entry);

  importedHistory.push({
    entry: { ...entry },
    previous: index >= 0 ? { ...words[index] } : null
  });

  const savedEntry = {
    ...entry,
    status,
    id: index >= 0
      ? words[index].id
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    addedAt: index >= 0
      ? words[index].addedAt
      : new Date().toISOString()
  };

  if (index >= 0) {
    words[index] = savedEntry;
  } else {
    words.unshift(savedEntry);
  }

  importedIndex += 1;
  saveBook();
  renderImportedWords();
}

function undoImportedClassification() {
  if (!importedHistory.length) return;

  const previous = importedHistory.pop();
  const index = findWordIndex(previous.entry);

  if (previous.previous) {
    if (index >= 0) words[index] = previous.previous;
  } else if (index >= 0) {
    words.splice(index, 1);
  }

  importedIndex = Math.max(0, importedIndex - 1);
  saveBook();
  renderImportedWords();
}

function renderImportedWords() {
  const container = $("importedResults");
  container.innerHTML = "";

  if (!importedWords.length) return;

  const heading = document.createElement("h3");
  heading.textContent = "読み込んだ単語を仕分け";
  container.appendChild(heading);

  const progressText = document.createElement("p");
  progressText.className = "muted";
  progressText.textContent = importedIndex >= importedWords.length
    ? `${importedWords.length} / ${importedWords.length} 語 完了`
    : `${importedIndex + 1} / ${importedWords.length} 語`;
  container.appendChild(progressText);

  const progressTrack = document.createElement("div");
  progressTrack.className = "progress-track";
  const progressBar = document.createElement("div");
  progressBar.className = "progress-bar";
  progressBar.style.width =
    `${Math.min(100, (importedIndex / importedWords.length) * 100)}%`;
  progressTrack.appendChild(progressBar);
  container.appendChild(progressTrack);

  if (importedIndex >= importedWords.length) {
    const complete = document.createElement("div");
    complete.className = "import-complete";
    complete.innerHTML = `
      <strong>仕分け完了！</strong>
      <p>読み込んだ ${importedWords.length} 語をすべて分類しました。</p>
    `;
    container.appendChild(complete);

    const controls = document.createElement("div");
    controls.className = "imported-controls";
    const undoButton = document.createElement("button");
    undoButton.className = "secondary";
    undoButton.textContent = "↶ 最後の仕分けを取り消す";
    undoButton.disabled = importedHistory.length === 0;
    undoButton.addEventListener("click", undoImportedClassification);
    controls.appendChild(undoButton);
    container.appendChild(controls);
    return;
  }

  const entry = importedWords[importedIndex];
  const card = document.createElement("article");
  card.className = "word-card imported-word-card";

  card.innerHTML = `
    <div class="word-title">
      <strong>${escapeHtml(entry.word)}</strong>
      ${posTag(entry)}
      ${entry.uncertain
        ? '<span class="tag warning-tag">要確認</span>'
        : ""}
    </div>
    <div class="meaning">${escapeHtml(entry.meaning)}</div>
    <div class="detail">
      出現回数：${entry.count}
      ${entry.forms.length
        ? " ／ 本文中の形：" + escapeHtml(entry.forms.join(", "))
        : ""}
    </div>
    <p class="muted imported-hint">意味を確認して、どちらかを選んでください。</p>
    <div class="word-actions">
      <button class="unknown-button">わからない</button>
      <button class="known-button">わかる</button>
    </div>
  `;
card.querySelector(".unknown-button").addEventListener(
  "click",
  () => selectImported(entry, "unknown", card)
);

card.querySelector(".known-button").addEventListener(
  "click",
  () => selectImported(entry, "known", card)
);
  container.appendChild(card);

  const controls = document.createElement("div");
  controls.className = "imported-controls";
  const undoButton = document.createElement("button");
  undoButton.className = "secondary";
  undoButton.textContent = "↶ ひとつ戻る";
  undoButton.disabled = importedHistory.length === 0;
  undoButton.addEventListener("click", undoImportedClassification);
  controls.appendChild(undoButton);
  container.appendChild(controls);
}

// ------------------------------
// 単語一覧
// ------------------------------

document.querySelectorAll("[data-book-filter]").forEach(button => {
  button.addEventListener("click", () => {
    currentBookFilter = button.dataset.bookFilter;

    document.querySelectorAll("[data-book-filter]").forEach(b => {
      b.classList.toggle("active", b === button);
    });

    renderBook();
  });
});

function renderBook() {
  const list = $("wordList");

  const knownCount = words.filter(
    w => w.status === "known"
  ).length;

  const unknownCount = words.filter(
    w => w.status !== "known"
  ).length;

  $("totalCount").textContent = words.length;
  $("knownCount").textContent = knownCount;
  $("unknownCount").textContent = unknownCount;

  const filtered = words.filter(word => {
    if (currentBookFilter === "known") {
      return word.status === "known";
    }

    if (currentBookFilter === "unknown") {
      return word.status !== "known";
    }

    return true;
  });

  list.innerHTML = "";

  if (!filtered.length) {
    list.innerHTML =
      '<p class="empty">この分類にはまだ単語がありません。</p>';
    return;
  }

  filtered.forEach(entry => {
    const card = document.createElement("article");
    card.className = "word-card";

    const statusClass = entry.status === "known"
      ? "status-known"
      : "status-unknown";

    const statusText = entry.status === "known"
      ? "わかる"
      : "わからない";

    card.innerHTML = `
      <div class="word-title">
        <strong>${escapeHtml(entry.word)}</strong>
        ${posTag(entry)}
      </div>
      <div class="meaning">${escapeHtml(entry.meaning)}</div>
      <div class="detail">
        出現回数：${entry.count}
        ${entry.forms?.length
          ? " ／ " + escapeHtml(entry.forms.join(", "))
          : ""}
      </div>
      ${entry.uncertain
        ? '<div class="detail warning-text">読み取り・意味を要確認</div>'
        : ""}
      <div class="word-card-footer">
        <span class="status-label ${statusClass}">${statusText}</span>
        <button class="small-button">分類変更</button>
        <button class="small-button delete-word">削除</button>
      </div>
    `;

    card.querySelector(".small-button").addEventListener(
      "click",
      () => {
        entry.status = entry.status === "known"
          ? "unknown"
          : "known";

        saveBook();
      }
    );

    card.querySelector(".delete-word").addEventListener(
      "click",
      () => {
        words = words.filter(w => w.id !== entry.id);
        saveBook();
      }
    );

    list.appendChild(card);
  });
}

// ------------------------------
// カード学習
// ------------------------------

// 現在の分類条件に合う単語
function getBaseDeck() {
  return words.filter(word => {
    if (currentDeck === "known") {
      return word.status === "known";
    }

    if (currentDeck === "unknown") {
      return word.status !== "known";
    }

    return true;
  });
}

// 単語を識別するためのキー
function getEntryKey(entry) {
  return (
    entry.word.toLowerCase() +
    "::" +
    Boolean(entry.phrase)
  );
}

// 今回まだ仕分けていない単語
function getDeck() {
  return getBaseDeck().filter(word =>
    !classifiedThisSession.has(getEntryKey(word))
  );
}

// 学習する単語の絞り込み
document.querySelectorAll("[data-deck]").forEach(button => {
  button.addEventListener("click", () => {
    currentDeck = button.dataset.deck;

    // 新しい仕分けを開始
    classifiedThisSession.clear();
    classifyHistory = [];

    currentCardIndex = 0;
    isFlipped = false;

    document.querySelectorAll("[data-deck]").forEach(b => {
      b.classList.toggle("active", b === button);
    });

    sessionTotal = getBaseDeck().length;

    renderStudyCard();
  });
});

// カード表示
function renderStudyCard() {
  const deck = getDeck();
  const done = classifiedThisSession.size;
    // 分類ボタンとカードの選択状態を更新
  $("flashcard").classList.remove(
    "classified-known",
    "classified-unknown"
  );

  $("markKnown").classList.remove("selected");
  $("markUnknown").classList.remove("selected");

  if (lastClassification === "known") {
    $("flashcard").classList.add("classified-known");
    $("markKnown").classList.add("selected");
  }

  if (lastClassification === "unknown") {
    $("flashcard").classList.add("classified-unknown");
    $("markUnknown").classList.add("selected");
  }

  $("cardCounter").textContent =
    `${done} / ${sessionTotal} 完了`;

  $("studyProgressText").textContent =
    `残り ${deck.length} 語`;

  $("studyProgressBar").style.width =
    sessionTotal > 0
      ? `${(done / sessionTotal) * 100}%`
      : "0%";

  $("undoClassify").disabled =
    classifyHistory.length === 0;

  if (!deck.length) {
    $("cardMeaning").classList.add("hidden");
    $("flashcard").classList.remove("flipped");

    $("markKnown").disabled = true;
    $("markUnknown").disabled = true;
    $("flipCard").disabled = true;

    if (sessionTotal > 0 && done >= sessionTotal) {
      $("cardSide").textContent = "COMPLETE";
      $("cardWord").textContent = "仕分け完了！";
      $("cardHint").textContent =
        "すべての単語を分類しました";
      $("studyMessage").textContent =
        `${done}語すべての仕分けが終わりました！`;
    } else {
      $("cardSide").textContent = "NO WORDS";
      $("cardWord").textContent = "単語がありません";
      $("cardHint").textContent =
        "単語を追加してください";
      $("studyMessage").textContent = "";
    }

    return;
  }

  $("markKnown").disabled = false;
  $("markUnknown").disabled = false;
  $("flipCard").disabled = false;

  const entry = deck[0];

  $("cardWord").textContent = entry.word;
  $("cardMeaning").textContent = entry.meaning;
  // 品詞を色付きで表示
$("cardPos").textContent = entry.pos;
$("cardPos").className =
  `tag pos-tag ${getPosClass(entry.pos)}`;

  $("cardSide").textContent =
    isFlipped ? "JAPANESE" : "ENGLISH";

  $("cardMeaning").classList.toggle(
    "hidden",
    !isFlipped
  );

  $("cardHint").textContent = isFlipped
    ? `${entry.pos} ・ 出現回数 ${entry.count}`
    : "タップして意味を確認";

  $("flashcard").classList.toggle(
    "flipped",
    isFlipped
  );

  $("flipCard").textContent = isFlipped
    ? "英語に戻す"
    : "意味を見る";

  $("studyMessage").textContent =
    entry.status === "known"
      ? "現在の分類：わかる"
      : "現在の分類：わからない";
}

// カードを裏返す
function flipCard() {
  if (!getDeck().length) return;

  isFlipped = !isFlipped;
  renderStudyCard();
}

$("flashcard").addEventListener("click", () => {
  if (ignoreNextCardClick) return;
  flipCard();
});

$("flipCard").addEventListener("click", flipCard);


// ------------------------------
// 単語の仕分け
// ------------------------------

function markCurrentWord(status) {
  const deck = getDeck();

  if (!deck.length) return;

  const entry = deck[0];
  const index = findWordIndex(entry);

  if (index < 0) return;

  // 取り消し用に変更前の状態を保存
  classifyHistory.push({
    word: words[index].word,
    phrase: words[index].phrase,
    status: words[index].status
  });

  words[index].status = status;

  // 今回の仕分け済みに追加
  classifiedThisSession.add(getEntryKey(entry));

  isFlipped = false;

  // 選択した分類を記録
  lastClassification = status;

  // 前のタイマーを解除
  clearTimeout(classificationTimer);

  // まず現在のカードに分類結果を表示
  renderBook();
  renderStudyCard();

  // 450ミリ秒後に色を消して次のカードへ
  classificationTimer = setTimeout(() => {
    lastClassification = null;
    saveBook();
  }, 450);
}

// ------------------------------
// 仕分けの取り消し
// ------------------------------

function undoClassification() {
  if (!classifyHistory.length) return;

  const previous = classifyHistory.pop();

  const index = words.findIndex(w =>
    w.word.toLowerCase() === previous.word.toLowerCase() &&
    Boolean(w.phrase) === Boolean(previous.phrase)
  );

  if (index < 0) return;

  words[index].status = previous.status;

  // 仕分け済みから戻す
  classifiedThisSession.delete(
    getEntryKey(words[index])
  );

  isFlipped = false;

  saveBook();
}

$("undoClassify").addEventListener(
  "click",
  undoClassification
);

$("markKnown").addEventListener("click", () => {
  markCurrentWord("known");
});

$("markUnknown").addEventListener("click", () => {
  markCurrentWord("unknown");
});

// ------------------------------
// スワイプ操作
// ------------------------------

$("flashcard").addEventListener(
  "pointerdown",
  event => {
    if (event.pointerType === "mouse") return;

    touchStartX = event.clientX;
    touchStartY = event.clientY;
    isPointerDown = true;
  }
);

$("flashcard").addEventListener(
  "pointerup",
  event => {
    if (
      event.pointerType === "mouse" ||
      !isPointerDown
    ) {
      return;
    }

    isPointerDown = false;

    const diffX = event.clientX - touchStartX;
    const diffY = event.clientY - touchStartY;

    // 横方向に十分動いたときだけ仕分けする
    if (
      Math.abs(diffX) < 55 ||
      Math.abs(diffX) < Math.abs(diffY) * 1.25
    ) {
      return;
    }

    ignoreNextCardClick = true;

    if (diffX < 0) {
      markCurrentWord("unknown");
    } else {
      markCurrentWord("known");
    }

    setTimeout(() => {
      ignoreNextCardClick = false;
    }, 300);
  }
);

$("flashcard").addEventListener(
  "pointercancel",
  () => {
    isPointerDown = false;
  }
);

// ------------------------------
// キーボード操作
// ------------------------------

document.addEventListener("keydown", event => {
  if (!document.body.classList.contains("study-mode")) {
    return;
  }

  const active = document.activeElement;

  if (
    active &&
    (
      active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.tagName === "SELECT" ||
      active.isContentEditable
    )
  ) {
    return;
  }

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    markCurrentWord("unknown");
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    markCurrentWord("known");
  }

  if (event.key === "Backspace") {
    event.preventDefault();
    undoClassification();
  }

  if (
    event.key === " " ||
    event.key === "Enter"
  ) {
    if (event.target === $("flashcard")) return;

    event.preventDefault();
    flipCard();
  }
});

// ------------------------------
// 単語帳の全削除
// ------------------------------

$("clearBook").addEventListener("click", () => {
  if (!words.length) return;

  if (
    confirm(
      "単語帳の内容をすべて削除します。よろしいですか？"
    )
  ) {
    words = [];
    classifyHistory = [];
    currentCardIndex = 0;
    saveBook();
  }
});
// ------------------------------
// 初期表示
// ------------------------------

sessionTotal = getBaseDeck().length;

renderBook();
renderStudyCard();
