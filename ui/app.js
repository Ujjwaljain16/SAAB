// SAAB Mission Control Frontend Application Logic

document.addEventListener('DOMContentLoaded', () => {
  // -------------------------------------------------------------
  // TAB NAVIGATION
  // -------------------------------------------------------------
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTabId = btn.getAttribute('data-tab');

      tabBtns.forEach((b) => b.classList.remove('active'));
      tabContents.forEach((c) => c.classList.remove('active'));

      btn.classList.add('active');
      const targetContent = document.getElementById(targetTabId);
      if (targetContent) targetContent.classList.add('active');
    });
  });

  // -------------------------------------------------------------
  // STATUS & COURSES RENDERING
  // -------------------------------------------------------------
  const systemDot = document.getElementById('systemDot');
  const systemStatusText = document.getElementById('systemStatusText');
  const courseCardsContainer = document.getElementById('courseCardsContainer');
  const btnRun = document.getElementById('btnRun');
  const btnStop = document.getElementById('btnStop');

  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      renderStatus(data);
    } catch (err) {
      console.error('Failed to fetch status:', err);
    }
  }

  function renderStatus(data) {
    const btnRunScaler = document.getElementById('btnRunScaler');
    const btnStopScaler = document.getElementById('btnStopScaler');

    if (data.isRunning) {
      systemDot.classList.add('busy');
      systemStatusText.textContent = 'Academic Assistant Running...';
      btnRun.style.display = 'none';
      btnStop.style.display = 'inline-flex';
      if (btnRunScaler) btnRunScaler.style.display = 'none';
      if (btnStopScaler) btnStopScaler.style.display = 'inline-flex';
    } else {
      systemDot.classList.remove('busy');
      systemStatusText.textContent = 'Ready / Idle';
      btnRun.style.display = 'inline-flex';
      btnStop.style.display = 'none';
      if (btnRunScaler) btnRunScaler.style.display = 'inline-flex';
      if (btnStopScaler) btnStopScaler.style.display = 'none';
    }

    if (Array.isArray(data.courses) && courseCardsContainer) {
      courseCardsContainer.innerHTML = '';
      data.courses.forEach((c) => {
        const card = document.createElement('div');
        card.className = 'course-card glass';

        let badgeHtml = '';
        let gradeHtml = '';

        if (c.grade !== null && c.grade >= 80) {
          badgeHtml = `<span class="badge badge-passed">✓ PASSED (${c.grade}%)</span>`;
          gradeHtml = `<span class="grade-badge">${c.grade}%</span>`;
        } else if (c.status === 'pass' && c.grade === null) {
          badgeHtml = `<span class="badge badge-passed">✓ SUBMITTED (100% Solved)</span>`;
          gradeHtml = `<span class="grade-badge" style="color: var(--accent-emerald);">Submitted</span>`;
        } else if (c.status === 'fail' || (c.grade !== null && c.grade < 80)) {
          badgeHtml = `<span class="badge badge-pending">⚠️ RETAKE REQUIRED (${c.grade}%)</span>`;
          gradeHtml = `<span class="grade-badge" style="color: var(--accent-amber);">${c.grade}%</span>`;
        } else {
          badgeHtml = `<span class="badge badge-locked">⏳ PENDING</span>`;
          gradeHtml = `<span style="font-size: 0.82rem; color: var(--text-dim);">Ready to Solve</span>`;
        }

        const quizLink = c.url
          ? `<a href="${c.url}" target="_blank" style="color: var(--accent-cyan); text-decoration: none; font-weight: 500;">${escapeHtml(c.currentQuiz)} ↗</a>`
          : `<span>${escapeHtml(c.currentQuiz)}</span>`;

        card.innerHTML = `
          <div>
            <div class="course-header">
              <h3 class="course-name">${escapeHtml(c.name)}</h3>
              ${badgeHtml}
            </div>
            <div class="quiz-details">
              <span><strong>Assignment:</strong> ${quizLink}</span>
              <span class="quiz-due">📊 Tracked attempts: ${c.totalQuizzesAttempted || 1} assessment(s)</span>
            </div>
          </div>
          <div class="course-footer">
            <span style="font-size: 0.78rem; color: var(--text-muted);">Recorded Grade:</span>
            ${gradeHtml}
          </div>
        `;
        courseCardsContainer.appendChild(card);
      });
    }

    // Render Top Dynamic Quick Stats for ALL enrolled courses
    const statsGridContainer = document.getElementById('statsGridContainer');
    if (statsGridContainer && Array.isArray(data.courses)) {
      statsGridContainer.innerHTML = '';

      // 1. Overall Degree Status Card
      const passedCount = data.courses.filter((c) => c.status === 'pass').length;
      const totalCount = data.courses.length;
      const numericGrades = data.courses
        .map((c) => c.grade)
        .filter((g) => typeof g === 'number' && !isNaN(g));
      const avgGrade =
        numericGrades.length > 0
          ? (numericGrades.reduce((a, b) => a + b, 0) / numericGrades.length).toFixed(1)
          : '100';

      const degreeCard = document.createElement('div');
      degreeCard.className = 'stat-card glass';
      degreeCard.innerHTML = `
        <div class="stat-info">
          <h4>Degree Status</h4>
          <div class="stat-value" style="color: var(--accent-emerald);">${passedCount}/${totalCount} Passed (${avgGrade}%)</div>
        </div>
        <div class="stat-icon" style="color: var(--accent-emerald);">🎓</div>
      `;
      statsGridContainer.appendChild(degreeCard);

      // 2. Individual Cards for EVERY enrolled course
      data.courses.forEach((c) => {
        const cCard = document.createElement('div');
        cCard.className = 'stat-card glass';

        let icon = '⚡';
        let iconColor = 'var(--accent-emerald)';
        const slug = (c.slug || '').toLowerCase();
        if (slug.includes('network')) {
          icon = '🌐';
          iconColor = 'var(--accent-cyan)';
        } else if (slug.includes('software') || slug.includes('dev')) {
          icon = '💻';
          iconColor = 'var(--accent-purple)';
        } else if (slug.includes('database') || slug.includes('data')) {
          icon = '🗄️';
          iconColor = 'var(--accent-emerald)';
        }

        let displayVal = 'Pending';
        let valColor = 'var(--text-dim)';
        if (c.grade !== null && !isNaN(c.grade)) {
          displayVal = `${c.grade}%`;
          valColor = c.grade >= 80 ? 'var(--accent-emerald)' : 'var(--accent-amber)';
        } else if (c.status === 'pass') {
          displayVal = '100% (Passed)';
          valColor = 'var(--accent-emerald)';
        }

        // Shorten long course names for compact stat header
        let shortName = c.name;
        if (shortName.includes('Network Programming')) shortName = 'Network Programming';
        if (shortName.includes('Software Development Practices')) shortName = 'Software Dev Practices';
        if (shortName.includes('Modern Databases')) shortName = 'Modern Databases';

        cCard.innerHTML = `
          <div class="stat-info">
            <h4 title="${escapeHtml(c.name)}">${escapeHtml(shortName)}</h4>
            <div class="stat-value" style="color: ${valColor}; font-size: 1.15rem;">${displayVal}</div>
          </div>
          <div class="stat-icon" style="color: ${iconColor};">${icon}</div>
        `;
        statsGridContainer.appendChild(cCard);
      });

      // 3. ReAct Loop Status Card
      const reactCard = document.createElement('div');
      reactCard.className = 'stat-card glass';
      reactCard.innerHTML = `
        <div class="stat-info">
          <h4>ReAct Loop</h4>
          <div class="stat-value" style="color: var(--accent-blue);">SOTA Active</div>
        </div>
        <div class="stat-icon" style="color: var(--accent-blue);">🔁</div>
      `;
      statsGridContainer.appendChild(reactCard);
    }

    // Dynamically update course filter dropdown options with all enrolled subjects
    const courseFilter = document.getElementById('courseFilter');
    if (courseFilter && Array.isArray(data.courses) && data.courses.length > 0) {
      const currentVal = courseFilter.value;
      const optionsHtml = ['<option value="">All Pending Deadlines</option>'];
      data.courses.forEach((c) => {
        optionsHtml.push(`<option value="${c.slug}">${escapeHtml(c.name)}</option>`);
      });
      courseFilter.innerHTML = optionsHtml.join('');
      if (currentVal) courseFilter.value = currentVal;
    }
  }

  // Live Sync Button Handler
  const btnSyncLiveCourses = document.getElementById('btnSyncLiveCourses');
  if (btnSyncLiveCourses) {
    btnSyncLiveCourses.addEventListener('click', async () => {
      const originalHtml = btnSyncLiveCourses.innerHTML;
      btnSyncLiveCourses.disabled = true;
      btnSyncLiveCourses.innerHTML = '<span>⏳ Syncing from Coursera...</span>';

      try {
        const res = await fetch('/api/sync-courses', { method: 'POST' });
        const resData = await res.json();
        if (resData.success) {
          await fetchStatus();
          if (resData.courses?.length === 0) {
            alert(`Coursera returned 0 courses. If you haven't logged in yet, click "Login Coursera" above to sign in with Google once in Chrome, then re-sync!`);
          } else {
            alert(`Successfully synced ${resData.courses?.length || 0} enrolled course(s) from your Coursera degree account!`);
          }
        } else {
          alert(`Sync failed: ${resData.error || 'Check terminal logs'}`);
        }
      } catch (err) {
        console.error('Sync request failed:', err);
        alert(`Sync request failed: ${err.message}`);
      } finally {
        btnSyncLiveCourses.disabled = false;
        btnSyncLiveCourses.innerHTML = originalHtml;
      }
    });
  }

  const btnLoginCoursera = document.getElementById('btnLoginCoursera');
  if (btnLoginCoursera) {
    btnLoginCoursera.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/auth/bits', { method: 'POST' });
        const data = await res.json();
        alert(data.message || 'Chrome window opened for Coursera login. Please sign in and close it when done.');
      } catch (err) {
        alert('Failed to launch Coursera login: ' + err.message);
      }
    });
  }

  const btnLoginScaler = document.getElementById('btnLoginScaler');
  if (btnLoginScaler) {
    btnLoginScaler.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/auth/scaler', { method: 'POST' });
        const data = await res.json();
        alert(data.message || 'Chrome window opened for Scaler login. Please sign in and close it when done.');
      } catch (err) {
        alert('Failed to launch Scaler login: ' + err.message);
      }
    });
  }

  // -------------------------------------------------------------
  // ANSWER STORE & INGESTION
  // -------------------------------------------------------------
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const btnBrowse = document.getElementById('btnBrowse');
  const questionsContainer = document.getElementById('questionsContainer');
  const totalQuestionsCount = document.getElementById('totalQuestionsCount');
  const answersSummaryCount = document.getElementById('answersSummaryCount');
  const filterQuestionsInput = document.getElementById('filterQuestionsInput');

  let allQuestions = [];
  let fetchAnswersTimeout = null;

  function scheduleFetchAnswers(delayMs = 150) {
    clearTimeout(fetchAnswersTimeout);
    fetchAnswersTimeout = setTimeout(() => {
      fetchAnswers();
    }, delayMs);
  }

  async function fetchAnswers() {
    try {
      const res = await fetch('/api/answers');
      const data = await res.json();
      allQuestions = data.entries || [];
      if (totalQuestionsCount) totalQuestionsCount.textContent = allQuestions.length;
      if (answersSummaryCount) answersSummaryCount.textContent = `${allQuestions.length} verified question(s) indexed`;
      renderQuestions(allQuestions);
    } catch (err) {
      console.error('Failed to fetch answers:', err);
    }
  }

  function renderQuestions(items) {
    if (!questionsContainer) return;
    questionsContainer.innerHTML = '';

    if (items.length === 0) {
      questionsContainer.innerHTML = `
        <div style="font-size: 0.85rem; color: var(--text-muted); text-align: center; padding: 2rem;">
          No answer keys indexed yet. Drop a PDF, JSON, TXT, or MD file above to index answers.
        </div>
      `;
      return;
    }

    items.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = 'question-item';

      const answersHtml = (item.correctAnswers || [])
        .map((a) => `<span class="ans-tag">✓ ${escapeHtml(a)}</span>`)
        .join('');

      el.innerHTML = `
        <div class="question-prompt">
          <span style="color: var(--accent-cyan); font-weight: 600;">Q${idx + 1}.</span> ${escapeHtml(item.prompt)}
        </div>
        <div class="question-answers">
          ${answersHtml}
        </div>
        <div style="font-size: 0.72rem; color: var(--text-dim); margin-top: 0.2rem;">
          Source: ${escapeHtml(item.source || 'uploaded')}
        </div>
      `;
      questionsContainer.appendChild(el);
    });
  }

  if (filterQuestionsInput) {
    filterQuestionsInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      if (!query) {
        renderQuestions(allQuestions);
        return;
      }
      const filtered = allQuestions.filter((q) =>
        q.prompt.toLowerCase().includes(query) ||
        (q.correctAnswers || []).some((a) => a.toLowerCase().includes(query))
      );
      renderQuestions(filtered);
    });
  }

  // Browse File trigger
  if (btnBrowse && fileInput) {
    btnBrowse.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        uploadFile(e.target.files[0]);
      }
    });
  }

  // Dropzone drag-and-drop
  if (dropzone) {
    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        uploadFile(e.dataTransfer.files[0]);
      }
    });
  }

  async function uploadFile(file) {
    const originalText = dropzone.querySelector('h3').textContent;
    dropzone.querySelector('h3').textContent = `Uploading & Parsing ${file.name}...`;

    try {
      const uploadUrl = `/api/upload?filename=${encodeURIComponent(file.name)}`;
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file
      });
      const data = await res.json();

      if (data.success) {
        alert(`🎉 Ingested ${data.filename}! ${data.questionsParsed} question(s) parsed into ground-truth store.`);
        scheduleFetchAnswers(50);
      } else {
        alert(`⚠️ Upload error: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`⚠️ Network or upload failed: ${err.message}`);
    } finally {
      dropzone.querySelector('h3').textContent = originalText;
    }
  }

  // -------------------------------------------------------------
  // RUN / STOP CONTROLS
  // -------------------------------------------------------------
  if (btnRun) {
    btnRun.addEventListener('click', async () => {
      const mode = document.getElementById('runMode')?.value || 'submit';
      const course = document.getElementById('courseFilter')?.value || '';
      const limit = parseInt(document.getElementById('runLimit')?.value || '0', 10);

      try {
        btnRun.disabled = true;
        const res = await fetch('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, course, limit })
        });
        const data = await res.json();
        if (!res.ok) {
          alert(`Could not start: ${data.error || 'Server error'}`);
        } else {
          // Switch to Live Terminal tab automatically
          const termTabBtn = document.querySelector('.tab-btn[data-tab="tab-terminal"]');
          if (termTabBtn) termTabBtn.click();
        }
      } catch (err) {
        alert(`Failed to trigger run: ${err.message}`);
      } finally {
        btnRun.disabled = false;
        fetchStatus();
      }
    });
  }

  if (btnStop) {
    btnStop.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to stop the current academic assistant task?')) return;
      try {
        btnStop.disabled = true;
        const res = await fetch('/api/stop', { method: 'POST' });
        const data = await res.json();
        alert(data.message || 'Process stopped.');
      } catch (err) {
        alert(`Stop failed: ${err.message}`);
      } finally {
        btnStop.disabled = false;
        fetchStatus();
      }
    });
  }

  // Scaler Runner
  const btnRunScaler = document.getElementById('btnRunScaler');
  const btnStopScaler = document.getElementById('btnStopScaler');

  if (btnRunScaler) {
    btnRunScaler.addEventListener('click', async () => {
      const mode = document.getElementById('scalerRunMode')?.value || 'submit';
      const scalerScope = document.getElementById('scalerScope')?.value || 'all';
      const scalerClass = document.getElementById('scalerClassInput')?.value?.trim() || '';

      try {
        btnRunScaler.disabled = true;
        const res = await fetch('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: 'scaler', mode, scalerScope, scalerClass })
        });
        const data = await res.json();
        if (!res.ok) {
          alert(`Could not start Scaler assistant: ${data.error || 'Server error'}`);
        } else {
          const termTabBtn = document.querySelector('.tab-btn[data-tab="tab-terminal"]');
          if (termTabBtn) termTabBtn.click();
        }
      } catch (err) {
        alert(`Failed to trigger Scaler run: ${err.message}`);
      } finally {
        btnRunScaler.disabled = false;
        fetchStatus();
      }
    });
  }

  if (btnStopScaler) {
    btnStopScaler.addEventListener('click', async () => {
      if (!confirm('Stop Scaler assistant task?')) return;
      try {
        await fetch('/api/stop', { method: 'POST' });
      } finally {
        fetchStatus();
      }
    });
  }

  // -------------------------------------------------------------
  // SETTINGS & CREDENTIALS MODAL
  // -------------------------------------------------------------
  const settingsModal = document.getElementById('settingsModal');
  const btnOpenSettings = document.getElementById('btnOpenSettings');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const inputGeminiKey = document.getElementById('inputGeminiKey');
  const btnToggleGeminiKey = document.getElementById('btnToggleGeminiKey');
  const selectGeminiModel = document.getElementById('selectGeminiModel');
  const btnTestGeminiKey = document.getElementById('btnTestGeminiKey');
  const testKeyFeedback = document.getElementById('testKeyFeedback');
  const inputBitsEmail = document.getElementById('inputBitsEmail');
  const inputBitsPass = document.getElementById('inputBitsPass');
  const inputScalerEmail = document.getElementById('inputScalerEmail');
  const inputScalerPass = document.getElementById('inputScalerPass');
  const btnSaveSettings = document.getElementById('btnSaveSettings');

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) return;
      const s = await res.json();

      if (inputGeminiKey && s.geminiKeyMasked) {
        inputGeminiKey.placeholder = `Saved: ${s.geminiKeyMasked}`;
      }
      if (selectGeminiModel && s.geminiModel) {
        selectGeminiModel.value = s.geminiModel;
      }
      if (inputBitsEmail && s.bitsEmail) {
        inputBitsEmail.value = s.bitsEmail;
      }
      if (inputBitsPass && s.hasBitsPass) {
        inputBitsPass.placeholder = '•••••••••••• (Saved)';
      }
      if (inputScalerEmail && s.scalerEmail) {
        inputScalerEmail.value = s.scalerEmail;
      }
      if (inputScalerPass && s.hasScalerPass) {
        inputScalerPass.placeholder = '•••••••••••• (Saved)';
      }
    } catch (err) {
      console.warn('Could not load settings:', err);
    }
  }

  if (btnOpenSettings && settingsModal) {
    btnOpenSettings.addEventListener('click', () => {
      loadSettings();
      settingsModal.classList.add('active');
    });
  }

  if (btnCloseSettings && settingsModal) {
    btnCloseSettings.addEventListener('click', () => {
      settingsModal.classList.remove('active');
    });
  }

  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) {
        settingsModal.classList.remove('active');
      }
    });
  }

  if (btnToggleGeminiKey && inputGeminiKey) {
    btnToggleGeminiKey.addEventListener('click', () => {
      const isPass = inputGeminiKey.type === 'password';
      inputGeminiKey.type = isPass ? 'text' : 'password';
      btnToggleGeminiKey.textContent = isPass ? 'Hide' : 'Show';
    });
  }

  if (btnTestGeminiKey && testKeyFeedback) {
    btnTestGeminiKey.addEventListener('click', async () => {
      const apiKey = inputGeminiKey?.value?.trim() || '';
      const model = selectGeminiModel?.value || 'gemini-2.5-flash';

      testKeyFeedback.style.display = 'block';
      testKeyFeedback.style.background = 'rgba(59, 130, 246, 0.15)';
      testKeyFeedback.style.color = '#93c5fd';
      testKeyFeedback.style.border = '1px solid rgba(59, 130, 246, 0.3)';
      testKeyFeedback.textContent = '⏳ Testing connection with Google API...';

      try {
        const res = await fetch('/api/test-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, model })
        });
        const data = await res.json();

        if (data.success) {
          testKeyFeedback.style.background = 'rgba(16, 185, 129, 0.15)';
          testKeyFeedback.style.color = '#34d399';
          testKeyFeedback.style.border = '1px solid rgba(16, 185, 129, 0.3)';
          testKeyFeedback.textContent = `✓ ${data.message}`;
        } else {
          testKeyFeedback.style.background = 'rgba(244, 63, 94, 0.15)';
          testKeyFeedback.style.color = '#f87171';
          testKeyFeedback.style.border = '1px solid rgba(244, 63, 94, 0.3)';
          testKeyFeedback.textContent = `⚠️ ${data.message}`;
        }
      } catch (err) {
        testKeyFeedback.style.background = 'rgba(244, 63, 94, 0.15)';
        testKeyFeedback.style.color = '#f87171';
        testKeyFeedback.textContent = `⚠️ Connection error: ${err.message}`;
      }
    });
  }

  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', async () => {
      btnSaveSettings.disabled = true;
      btnSaveSettings.textContent = 'Saving...';

      try {
        const payload = {
          geminiApiKey: inputGeminiKey?.value?.trim() || undefined,
          geminiModel: selectGeminiModel?.value || undefined,
          bitsEmail: inputBitsEmail?.value?.trim() || undefined,
          bitsPassword: inputBitsPass?.value || undefined,
          scalerEmail: inputScalerEmail?.value?.trim() || undefined,
          scalerPassword: inputScalerPass?.value || undefined
        };

        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (res.ok) {
          alert('✓ Configuration saved to local .env successfully!');
          if (settingsModal) settingsModal.classList.remove('active');
        } else {
          alert(`Save error: ${data.error || 'Server error'}`);
        }
      } catch (err) {
        alert(`Save failed: ${err.message}`);
      } finally {
        btnSaveSettings.disabled = false;
        btnSaveSettings.textContent = '💾 Save Configuration';
      }
    });
  }

  const btnRefreshStatus = document.getElementById('btnRefreshStatus');
  if (btnRefreshStatus) {
    btnRefreshStatus.addEventListener('click', fetchStatus);
  }

  // -------------------------------------------------------------
  // LIVE SSE TERMINAL & REACT EVENT STREAM
  // -------------------------------------------------------------
  const terminalOutput = document.getElementById('terminalOutput');
  const btnClearTerminal = document.getElementById('btnClearTerminal');
  const reactEventFeed = document.getElementById('reactEventFeed');

  if (btnClearTerminal && terminalOutput) {
    btnClearTerminal.addEventListener('click', () => {
      terminalOutput.textContent = '';
    });
  }

  function initSSE() {
    const evtSource = new EventSource('/api/stream');
    let hasReceivedLog = false;

    evtSource.addEventListener('connected', () => {
      // Stream established
    });

    evtSource.addEventListener('log', (e) => {
      try {
        const { text } = JSON.parse(e.data);
        if (terminalOutput) {
          if (!hasReceivedLog && terminalOutput.textContent.includes('Waiting for job execution')) {
            terminalOutput.textContent = '';
            hasReceivedLog = true;
          }
          terminalOutput.textContent += text;
          terminalOutput.scrollTop = terminalOutput.scrollHeight;
        }
      } catch {
        // ignore format issues
      }
    });

    evtSource.addEventListener('react_step', (e) => {
      try {
        const { type, line } = JSON.parse(e.data);
        if (reactEventFeed) {
          const item = document.createElement('div');
          item.style.padding = '0.5rem 0.75rem';
          item.style.borderRadius = '6px';
          item.style.fontSize = '0.8rem';
          item.style.fontFamily = 'var(--font-mono)';

          if (type === 'self_correct') {
            item.style.background = 'rgba(245, 158, 11, 0.12)';
            item.style.border = '1px solid rgba(245, 158, 11, 0.3)';
            item.style.color = '#fbbf24';
            item.textContent = `🔁 [ReAct Self-Correction] ${line}`;
          } else if (type === 'ground_truth') {
            item.style.background = 'rgba(16, 185, 129, 0.12)';
            item.style.border = '1px solid rgba(16, 185, 129, 0.3)';
            item.style.color = '#34d399';
            item.textContent = `⭐ [Ground Truth Match] ${line}`;
          } else {
            item.style.background = 'rgba(59, 130, 246, 0.12)';
            item.style.border = '1px solid rgba(59, 130, 246, 0.3)';
            item.style.color = '#60a5fa';
            item.textContent = `✓ [DOM Audit] ${line}`;
          }

          reactEventFeed.prepend(item);
        }
      } catch {
        // ignore
      }
    });

    evtSource.addEventListener('telemetry', (e) => {
      try {
        const data = JSON.parse(e.data);
        renderTelemetry(data);
      } catch {}
    });

    evtSource.addEventListener('screenshot', (e) => {
      try {
        const { url, timestamp } = JSON.parse(e.data);
        const canvasImg = document.getElementById('liveCanvasImg');
        const lastUpdated = document.getElementById('canvasLastUpdated');
        if (canvasImg) {
          canvasImg.src = url;
        }
        if (lastUpdated) {
          lastUpdated.textContent = `Last frame: ${new Date(timestamp).toLocaleTimeString()}`;
        }
      } catch {}
    });

    evtSource.addEventListener('run_start', () => {
      fetchStatus();
      loadRunHistory();
    });

    evtSource.addEventListener('run_end', () => {
      fetchStatus();
      loadRunHistory();
    });

    evtSource.addEventListener('answer_uploaded', () => {
      scheduleFetchAnswers(100);
    });

    evtSource.onerror = () => {
      // Reconnects automatically
    };
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // -------------------------------------------------------------
  // AI TELEMETRY & GAS GAUGES
  // -------------------------------------------------------------
  function renderTelemetry(telemetry) {
    if (!telemetry) return;
    const geminiRpm = document.getElementById('geminiRpm');
    const geminiGauge = document.getElementById('geminiGauge');
    const groqStatus = document.getElementById('groqStatus');

    if (telemetry.quotas && telemetry.quotas[0] && geminiRpm) {
      const q = telemetry.quotas[0];
      geminiRpm.textContent = `${q.rpm || 0} RPM (Day: ${q.today || 0})`;
    }

    if (telemetry.providers) {
      if (geminiGauge && telemetry.providers.gemini) {
        const slot0 = telemetry.providers.gemini.slots?.[0];
        const circuit = slot0?.circuit || 'CLOSED';
        const isDead = slot0?.isDead;
        const color = isDead || circuit === 'OPEN' ? '#ef4444' : (circuit === 'HALF_OPEN' ? '#f59e0b' : '#10b981');
        geminiGauge.innerHTML = `<span style="color: ${color};">●</span> Gemini: <span id="geminiRpm">${geminiRpm?.textContent || 'Active'}</span>`;
      }

      if (groqStatus && telemetry.providers.groq) {
        const circuit = telemetry.providers.groq.circuit || 'CLOSED';
        const isConfigured = telemetry.providers.groq.configured;
        if (!isConfigured) {
          groqStatus.textContent = 'Not Configured';
        } else if (circuit === 'OPEN') {
          groqStatus.textContent = 'Circuit OPEN';
          groqStatus.style.color = '#ef4444';
        } else {
          groqStatus.textContent = 'Ready (70B)';
          groqStatus.style.color = '#10b981';
        }
      }
    }
  }

  // -------------------------------------------------------------
  // LIVE VIEWPORT REFRESH
  // -------------------------------------------------------------
  const btnRefreshCanvas = document.getElementById('btnRefreshCanvas');
  if (btnRefreshCanvas) {
    btnRefreshCanvas.addEventListener('click', () => {
      const canvasImg = document.getElementById('liveCanvasImg');
      if (canvasImg) {
        canvasImg.src = `/api/screenshot/latest?t=${Date.now()}`;
      }
    });
  }

  // -------------------------------------------------------------
  // RUN HISTORY & AUDIT REPLAY
  // -------------------------------------------------------------
  const runsListContainer = document.getElementById('runsListContainer');
  const btnRefreshRuns = document.getElementById('btnRefreshRuns');
  const runDetailDrawer = document.getElementById('runDetailDrawer');
  const btnCloseRunDetail = document.getElementById('btnCloseRunDetail');

  if (btnRefreshRuns) {
    btnRefreshRuns.addEventListener('click', loadRunHistory);
  }

  if (btnCloseRunDetail && runDetailDrawer) {
    btnCloseRunDetail.addEventListener('click', () => {
      runDetailDrawer.style.display = 'none';
    });
  }

  async function loadRunHistory() {
    if (!runsListContainer) return;
    try {
      const res = await fetch('/api/runs');
      const data = await res.json();
      if (!data.ok || !data.runs || data.runs.length === 0) {
        runsListContainer.innerHTML = `
          <div style="font-size: 0.85rem; color: var(--text-muted); font-style: italic; padding: 1rem 0;">
            No historical run envelopes recorded yet. Runs will appear here automatically upon execution.
          </div>
        `;
        return;
      }

      runsListContainer.innerHTML = '';
      data.runs.slice(0, 15).forEach((run) => {
        const item = document.createElement('div');
        item.style.background = 'rgba(15, 23, 42, 0.6)';
        item.style.border = '1px solid var(--border-subtle)';
        item.style.borderRadius = '8px';
        item.style.padding = '0.85rem 1rem';
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.gap = '1rem';

        const dateStr = run.startedAt ? new Date(run.startedAt).toLocaleString() : 'Recent';
        const modeBadge = run.mode === 'submit'
          ? '<span class="badge badge-passed">LIVE SUBMIT</span>'
          : '<span class="badge badge-pending">DRY-RUN</span>';
        const solved = run.metrics?.problemsSolved || run.metrics?.solved || 0;
        const total = run.entryCount || 0;

        item.innerHTML = `
          <div>
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
              <span style="font-weight: 600; font-family: var(--font-mono); color: #fff;">${escapeHtml(run.runId)}</span>
              ${modeBadge}
            </div>
            <div style="font-size: 0.78rem; color: var(--text-muted);">
              Started: ${dateStr} • Items Handled: ${total} • Passed/Solved: ${solved}
            </div>
          </div>
          <button class="btn btn-secondary btn-inspect-run" data-run-id="${escapeHtml(run.runId)}" style="padding: 0.35rem 0.75rem; font-size: 0.78rem; white-space: nowrap;">
            Inspect Execution
          </button>
        `;

        runsListContainer.appendChild(item);
      });

      document.querySelectorAll('.btn-inspect-run').forEach((b) => {
        b.addEventListener('click', (e) => {
          const runId = e.currentTarget.getAttribute('data-run-id');
          if (runId) loadRunDetail(runId);
        });
      });
    } catch (err) {
      console.error('Failed to load runs:', err);
    }
  }

  async function loadRunDetail(runId) {
    if (!runDetailDrawer) return;
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
      const data = await res.json();
      if (!data.ok || !data.run) return;

      const run = data.run;
      const detailRunTitle = document.getElementById('detailRunTitle');
      const detailRunMetrics = document.getElementById('detailRunMetrics');
      const detailRunEntries = document.getElementById('detailRunEntries');

      if (detailRunTitle) {
        detailRunTitle.textContent = `Run Audit Envelope: ${run.runId}`;
      }

      if (detailRunMetrics) {
        const metrics = run.metrics || {};
        detailRunMetrics.innerHTML = `
          <div class="stat-card" style="padding: 0.65rem;">
            <div class="stat-label">Mode</div>
            <div class="stat-value" style="font-size: 1.1rem;">${escapeHtml(run.mode || 'dry-run')}</div>
          </div>
          <div class="stat-card" style="padding: 0.65rem;">
            <div class="stat-label">Problems Seen</div>
            <div class="stat-value" style="font-size: 1.1rem;">${metrics.problemsRead || metrics.assignmentsSeen || 0}</div>
          </div>
          <div class="stat-card" style="padding: 0.65rem;">
            <div class="stat-label">Solved / Passed</div>
            <div class="stat-value" style="font-size: 1.1rem; color: var(--accent-emerald);">${metrics.problemsSolved || metrics.solved || 0}</div>
          </div>
          <div class="stat-card" style="padding: 0.65rem;">
            <div class="stat-label">Failed</div>
            <div class="stat-value" style="font-size: 1.1rem; color: #ef4444;">${metrics.problemsFailed || metrics.failed || 0}</div>
          </div>
        `;
      }

      if (detailRunEntries) {
        detailRunEntries.innerHTML = '';
        const entries = Array.isArray(run.entries) ? run.entries : [];
        if (entries.length === 0) {
          detailRunEntries.innerHTML = `<div style="font-size: 0.8rem; color: var(--text-muted); font-style: italic;">No individual question entries logged in this run envelope.</div>`;
        } else {
          entries.forEach((e) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            row.style.padding = '0.45rem 0.65rem';
            row.style.borderRadius = '5px';
            row.style.background = 'rgba(15, 23, 42, 0.4)';
            row.style.fontSize = '0.8rem';
            row.style.fontFamily = 'var(--font-mono)';

            const status = e.result || e.status || 'unknown';
            let pillClass = 'badge-pending';
            let mark = '↺';
            if (status === 'pass') {
              pillClass = 'badge-passed';
              mark = '✓';
            } else if (status === 'fail') {
              pillClass = 'badge-failed';
              mark = '✗';
            }

            row.innerHTML = `
              <span style="color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 75%;">
                ${mark} ${escapeHtml(e.title || e.url || 'Item')}
              </span>
              <span class="badge ${pillClass}">${escapeHtml(status.toUpperCase())}</span>
            `;
            detailRunEntries.appendChild(row);
          });
        }
      }

      runDetailDrawer.style.display = 'block';
      runDetailDrawer.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      console.error('Failed to load run detail:', err);
    }
  }

  // Initial Data Load
  fetchStatus();
  fetchAnswers();
  loadRunHistory();
  initSSE();
});
