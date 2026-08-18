(() => {
  "use strict";

  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const cameraBtn = document.getElementById("camera-btn");
  const cameraInput = document.getElementById("camera-input");
  const sampleBtn = document.getElementById("sample-btn");

  const previewSection = document.getElementById("preview-section");
  const previewImg = document.getElementById("preview-img");
  const scanBtn = document.getElementById("scan-btn");
  const resetBtn = document.getElementById("reset-btn");

  const progressSection = document.getElementById("progress-section");
  const progressFill = document.getElementById("progress-fill");
  const progressLabel = document.getElementById("progress-label");

  const statusSection = document.getElementById("status-section");

  const resultSection = document.getElementById("result-section");
  const resultText = document.getElementById("result-text");
  const copyBtn = document.getElementById("copy-btn");
  const downloadBtn = document.getElementById("download-btn");
  const modeTextBtn = document.getElementById("mode-text-btn");
  const modeImageBtn = document.getElementById("mode-image-btn");
  const imageFormatView = document.getElementById("image-format-view");
  const imageFormatHint = document.getElementById("image-format-hint");

  const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
  let currentFile = null;
  let currentObjectUrl = null;
  let activeMode = "text";
  let imageFormatLines = []; // array of arrays of word span elements, grouped by line

  function show(el) {
    el.classList.remove("hidden");
  }

  function hide(el) {
    el.classList.add("hidden");
  }

  function setStatus(message, kind) {
    statusSection.textContent = message;
    statusSection.classList.remove("status--error", "status--success");
    if (!message) {
      hide(statusSection);
      return;
    }
    if (kind) {
      statusSection.classList.add(`status--${kind}`);
    }
    show(statusSection);
  }

  function resetResult() {
    resultText.value = "";
    hide(resultSection);
    setStatus("");
    hide(progressSection);
    progressFill.style.width = "0%";
    imageFormatView.innerHTML = "";
    imageFormatLines = [];
    setMode("text");
  }

  function setMode(mode) {
    activeMode = mode;
    modeTextBtn.classList.toggle("is-active", mode === "text");
    modeTextBtn.setAttribute("aria-pressed", String(mode === "text"));
    modeImageBtn.classList.toggle("is-active", mode === "image");
    modeImageBtn.setAttribute("aria-pressed", String(mode === "image"));

    if (mode === "text") {
      show(resultText);
      hide(imageFormatView);
      hide(imageFormatHint);
    } else {
      hide(resultText);
      show(imageFormatView);
      show(imageFormatHint);
    }
  }

  modeTextBtn.addEventListener("click", () => setMode("text"));
  modeImageBtn.addEventListener("click", () => setMode("image"));

  function renderImageFormatView(data, naturalWidth, naturalHeight) {
    imageFormatView.innerHTML = "";
    imageFormatLines = [];

    if (!naturalWidth || !naturalHeight || !Array.isArray(data.lines)) {
      return;
    }

    imageFormatView.style.aspectRatio = `${naturalWidth} / ${naturalHeight}`;

    data.lines.forEach((line) => {
      if (!Array.isArray(line.words) || line.words.length === 0) return;
      const lineSpans = [];

      line.words.forEach((word) => {
        const text = (word.text || "").trim();
        if (!text) return;
        const { x0, y0, x1, y1 } = word.bbox;
        const width = Math.max(x1 - x0, 1);
        const height = Math.max(y1 - y0, 1);

        const span = document.createElement("span");
        span.className = "image-format-word";
        span.contentEditable = "true";
        span.spellcheck = false;
        span.textContent = text;
        span.style.left = `${(x0 / naturalWidth) * 100}%`;
        span.style.top = `${(y0 / naturalHeight) * 100}%`;
        span.style.fontSize = `${(height / naturalWidth) * 100}cqw`;
        span.style.minWidth = `${(width / naturalWidth) * 100}%`;

        imageFormatView.appendChild(span);
        lineSpans.push(span);
      });

      if (lineSpans.length) {
        imageFormatLines.push(lineSpans);
      }
    });
  }

  function getActiveResultText() {
    if (activeMode === "image" && imageFormatLines.length) {
      return imageFormatLines
        .map((spans) => spans.map((s) => s.textContent).join(" ").trim())
        .join("\n")
        .trim();
    }
    return resultText.value;
  }

  function loadFile(file) {
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setStatus("That file doesn't look like an image. Please choose a JPG, PNG, WEBP, or BMP file.", "error");
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setStatus("That image is larger than 15 MB. Please choose a smaller file.", "error");
      return;
    }

    currentFile = file;
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
    }
    currentObjectUrl = URL.createObjectURL(file);
    previewImg.src = currentObjectUrl;

    resetResult();
    show(previewSection);
    previewSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Drop zone: click to open file picker
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", () => {
    loadFile(fileInput.files[0]);
    fileInput.value = "";
  });

  cameraBtn.addEventListener("click", () => cameraInput.click());
  cameraInput.addEventListener("change", () => {
    loadFile(cameraInput.files[0]);
    cameraInput.value = "";
  });

  // Drag and drop
  ["dragenter", "dragover"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    });
  });

  dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    loadFile(file);
  });

  // Paste from clipboard
  window.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        loadFile(item.getAsFile());
        break;
      }
    }
  });

  resetBtn.addEventListener("click", () => {
    currentFile = null;
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    previewImg.src = "";
    hide(previewSection);
    resetResult();
  });

  function generateSampleImage() {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 220;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111111";
    ctx.font = "bold 36px sans-serif";
    ctx.fillText("TextScanner sample", 30, 70);
    ctx.font = "24px sans-serif";
    ctx.fillText("The quick brown fox jumps over", 30, 120);
    ctx.fillText("the lazy dog.", 30, 155);
    ctx.font = "18px sans-serif";
    ctx.fillText("Click Scan text to extract this line.", 30, 195);

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        resolve(new File([blob], "sample.png", { type: "image/png" }));
      }, "image/png");
    });
  }

  sampleBtn.addEventListener("click", async () => {
    const file = await generateSampleImage();
    loadFile(file);
  });

  scanBtn.addEventListener("click", async () => {
    if (!currentFile) return;

    scanBtn.disabled = true;
    resetBtn.disabled = true;
    resetResult();
    show(progressSection);
    progressLabel.textContent = "Loading OCR engine...";

    try {
      const { data } = await Tesseract.recognize(currentFile, "eng", {
        logger: (msg) => {
          if (msg.status && typeof msg.progress === "number") {
            const percent = Math.round(msg.progress * 100);
            progressFill.style.width = `${percent}%`;
            progressLabel.textContent = `${formatStatus(msg.status)} (${percent}%)`;
          }
        },
      });

      const text = (data.text || "").trim();
      hide(progressSection);

      if (!text) {
        setStatus("No text was detected in this image. Try a clearer or higher-contrast image.", "error");
      } else {
        resultText.value = text;
        renderImageFormatView(data, previewImg.naturalWidth, previewImg.naturalHeight);
        setMode("text");
        show(resultSection);
        setStatus("Text extracted successfully.", "success");
      }
    } catch (err) {
      hide(progressSection);
      setStatus(`Something went wrong while scanning: ${err.message || err}`, "error");
    } finally {
      scanBtn.disabled = false;
      resetBtn.disabled = false;
    }
  });

  function formatStatus(status) {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  copyBtn.addEventListener("click", async () => {
    const text = getActiveResultText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const original = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1500);
    } catch {
      const temp = document.createElement("textarea");
      temp.value = text;
      temp.style.position = "fixed";
      temp.style.opacity = "0";
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      temp.remove();
    }
  });

  downloadBtn.addEventListener("click", () => {
    const text = getActiveResultText();
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "textscanner-result.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
})();
