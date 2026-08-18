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

  const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
  let currentFile = null;
  let currentObjectUrl = null;

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
    if (!resultText.value) return;
    try {
      await navigator.clipboard.writeText(resultText.value);
      const original = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1500);
    } catch {
      resultText.select();
      document.execCommand("copy");
    }
  });

  downloadBtn.addEventListener("click", () => {
    if (!resultText.value) return;
    const blob = new Blob([resultText.value], { type: "text/plain" });
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
