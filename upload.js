document.getElementById('fileUpload').addEventListener('change', function(event) {

    const file = event.target.files[0];
    if (!file) return;

    const id = "doc_" + Date.now();

    const fileEntry = {
        id: id,
        name: file.name,
        size: file.size,
        status: "uploaded",
        created: Date.now()
    };

    chrome.storage.local.get({documents: []}, function(data){

        const docs = data.documents;
        docs.push(fileEntry);

        chrome.storage.local.set({documents: docs});

        renderUploadEntry(fileEntry);

    });

});

function renderUploadEntry(doc){

    const list = document.getElementById("uploadList");

    const item = document.createElement("div");
    item.className = "list-group-item d-flex justify-content-between align-items-center";

    item.innerHTML = `
    
<div class="d-flex align-items-center">

<i class="bi bi-file-earmark-word text-primary fs-3 me-3"></i>

<div>
<div class="fw-semibold">${doc.name}</div>

<span class="badge bg-primary">DOCX</span>
</div>

</div>

<div>

<button class="btn btn-sm btn-success startConvert" data-id="${doc.id}">
<i class="bi bi-play-fill"></i>
Start
</button>

</div>
`;

    list.prepend(item);

}

document.getElementById("uploadList").addEventListener("click", function(e){

    if(!e.target.closest(".startConvert")) return;

    const id = e.target.closest(".startConvert").dataset.id;

    startConversion(id);

});

async function startConversion(docId) {
  console.log("Starting conversion for document ID:", docId);

  const input = document.getElementById("fileUpload");
  const file = input.files[0];

  if (!file) return;

  const reader = new FileReader();

  reader.onload = async function (loadEvent) {
    try {
      const arrayBuffer = loadEvent.target.result;

      const result = await mammoth.extractRawText({ arrayBuffer });
      const text = result.value;

      saveExtractedText(docId, text);

      // Unique request ID für diese Übersetzung
      const requestId = crypto.randomUUID();

      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: (payload, requestId) => {
          window.postMessage(
            {
              type: "DEEPL_TRANSLATE",
              payload: payload,
              requestId: requestId,
            },
            "*"
          );
        },
        args: [text, requestId],
      });

      console.log("Translation request sent:", requestId);

    } catch (err) {
      console.error("Mammoth / Translation error:", err);
    }
  };

  reader.readAsArrayBuffer(file);
}

function saveExtractedText(docId, text){

    chrome.storage.local.get({documents: []}, function(data){

        const docs = data.documents;

        const doc = docs.find(d => d.id === docId);

        if(doc){

            doc.text = text;
            doc.status = "parsed";

        }

        chrome.storage.local.set({documents: docs});

    });

}

function sendTextToDeepL(text){

    const url = "https://www.deepl.com/translator#auto/en/" + encodeURIComponent(text);

    chrome.tabs.create({url: url});

}