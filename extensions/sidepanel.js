function sendMessage(message, cb) {
  chrome.runtime.sendMessage(message, function (response) {
    if (cb) {
      cb(response);
    }
  });
}

function listenForMessage(callback) {
  chrome.runtime.onMessage.addListener(callback);
}

async function main() {
  const recordForm = document.getElementById("record");
  recordForm.addEventListener("submit", () => {
    const frames = document.getElementById("record_frames").value;
    const filename = document.getElementById("record_filename").value;
    sendMessage({ action: "record", frames: frames, filename: filename });
  });

  const inspectForm = document.getElementById("inspect");
  inspectForm.addEventListener("submit", () => {
    sendMessage({ action: "inspect" });
  });

  listenForMessage((message, sender) => {
    console.log(message);
    if (message.action == "_inspect_add_object") {
            
    }
  });
}

main();
