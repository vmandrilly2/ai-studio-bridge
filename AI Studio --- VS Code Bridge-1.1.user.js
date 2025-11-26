// ==UserScript==
// @name         AI Studio <-> VS Code Bridge
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Automate moving text between AI Studio and VS Code
// @author       You
// @match        https://aistudio.google.com/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    const VSCODE_API = "http://localhost:54321";

    function createUI() {
        // Prevent duplicate buttons if script re-runs
        if (document.getElementById('ai-bridge-container')) return;

        const div = document.createElement('div');
        div.id = 'ai-bridge-container';
        div.style.position = 'fixed';
        div.style.bottom = '20px';
        div.style.right = '20px';
        div.style.zIndex = '9999';
        div.style.background = '#222';
        div.style.padding = '10px';
        div.style.borderRadius = '8px';
        div.style.border = '1px solid #555';
        div.style.color = 'white';
        div.style.display = 'flex';
        div.style.gap = '10px';

        const btnPull = document.createElement('button');
        btnPull.id = 'btn-pull';
        btnPull.innerText = "⬇️ Load Prompt";
        btnPull.style.padding = '8px';
        btnPull.style.cursor = 'pointer';
        btnPull.onclick = () => fetchFromVSCode();

        const btnPush = document.createElement('button');
        btnPush.id = 'btn-push';
        btnPush.innerText = "⬆️ Send Code";
        btnPush.style.padding = '8px';
        btnPush.style.cursor = 'pointer';
        btnPush.onclick = sendToVSCode;

        div.appendChild(btnPull);
        div.appendChild(btnPush);
        document.body.appendChild(div);
    }

    // 1. FETCH FROM VS CODE
    function fetchFromVSCode(silent = false) {
        const btn = document.getElementById('btn-pull');
        const originalText = btn ? btn.innerText : "⬇️ Load Prompt";
        if (btn) btn.innerText = "⏳ Loading...";

        GM_xmlhttpRequest({
            method: "GET",
            url: `${VSCODE_API}/prompt`,
            onload: function(response) {
                if (response.status === 200) {
                    const data = JSON.parse(response.responseText);

                    // Try generic textarea first
                    let input = document.querySelector('textarea');

                    // Fallback for different AI Studio versions/states
                    if (!input) input = document.querySelector('div[contenteditable="true"]');

                    if (input) {
                        // Native value setter often required for React/Angular inputs
                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                        if (nativeInputValueSetter && input instanceof HTMLTextAreaElement) {
                            nativeInputValueSetter.call(input, data.prompt);
                        } else {
                            input.value = data.prompt;
                            input.innerText = data.prompt;
                        }

                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        
                        if (btn) {
                            btn.innerText = "✅ Loaded!";
                            setTimeout(() => btn.innerText = originalText, 2000);
                        }
                        // Removed alert as requested
                    } else {
                        if (!silent) alert("Could not find input box. Click the chat input first.");
                        if (btn) btn.innerText = originalText;
                    }
                } else {
                    if (!silent) alert("VS Code not responding.");
                    if (btn) btn.innerText = originalText;
                }
            },
            onerror: () => {
                if (!silent) alert("Connection failed. Check VS Code.");
                if (btn) btn.innerText = originalText;
            }
        });
    }

    // 2. SCRAPE AI STUDIO -> SEND TO VS CODE
    function sendToVSCode() {
        let content = "";

        // STRATEGY A: Target the code blocks identified in your snippet
        const codeBlocks = document.querySelectorAll('ms-code-block');

        if (codeBlocks.length > 0) {
            // Get the very last code block in the chat history
            const lastBlock = codeBlocks[codeBlocks.length - 1];

            // Find the <code> element inside
            const codeElement = lastBlock.querySelector('code');
            if (codeElement) {
                // textContent is safer than innerText as it avoids CSS styling artifacts
                content = codeElement.textContent;
            }
        }

        // STRATEGY B: Fallback to manual text selection
        if (!content) {
            content = window.getSelection().toString();
        }

        // Validation
        if (!content) {
            alert("Could not find any code blocks (ms-code-block) and no text is selected.");
            return;
        }

        const btn = document.getElementById('btn-push');
        const originalText = btn ? btn.innerText : "⬆️ Send Code";
        if (btn) btn.innerText = "⏳ Sending...";

        // Send
        GM_xmlhttpRequest({
            method: "POST",
            url: `${VSCODE_API}/response`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ text: content }),
            onload: function(response) {
                if (response.status === 200) {
                    const respData = JSON.parse(response.responseText);
                    
                    // Visual feedback
                    if (btn) {
                        btn.innerText = "✅ Sent!";
                        setTimeout(() => btn.innerText = originalText, 2000);
                    }

                    // AUTO-ACTION: If VS Code requests context, pull it automatically
                    if (respData.result && respData.result.action === 'NEED_CONTEXT') {
                        // Small delay to let UI settle
                        setTimeout(() => fetchFromVSCode(true), 500);
                    }
                } else {
                    alert("Error sending to VS Code.");
                    if (btn) btn.innerText = originalText;
                }
            },
            onerror: () => {
                alert("Connection failed.");
                if (btn) btn.innerText = originalText;
            }
        });
    }

    // Initialize
    setTimeout(createUI, 3000);
})();