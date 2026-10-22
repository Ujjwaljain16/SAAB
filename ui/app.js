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
    if (data.isRunning) {
      systemDot.classList.add('busy');
      systemStatusText.textContent = 'Auto-Solver Running...';
      btnRun.style.display = 'none';
      btnStop.style.display = 'inline-flex';
    } else {
      systemDot.classList.remove('busy');
      systemStatusText.textContent = 'Ready / Idle';
      btnRun.style.display = 'inline-flex';
      btnStop.style.display = 'none';
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
        } else if (c.status === 'fail' || (c.grade !== null && c.grade < 80)) {
          badgeHtml = `<span class="badge badge-pending">⚠️ RETAKE REQUIRED (${c.grade}%)</span>`;
          gradeHtml = `<span class="grade-badge" style="color: var(--accent-amber);">${c.grade}%</span>`;
        } else {
          badgeHtml = `<span class="badge badge-locked">🔒 LOCKED (NOV 1)</span>`;
          gradeHtml = `<span style="font-size: 0.82rem; color: var(--text-dim);">Opens Nov 1</span>`;
        }

        card.innerHTML = `
          <div>
            <div class="course-header">
              <h3 class="course-name">${escapeHtml(c.name)}</h3>
              ${badgeHtml}
            </div>
            <div class="quiz-details">
              <span><strong>Assignment:</strong> ${escapeHtml(c.currentQuiz)}</span>
              <span class="quiz-due">📅 Window: Week 4, 5, 6 Graded Assessment</span>
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

    // Update Quick Stats
    const mdbGradeEl = document.getElementById('mdbGrade');
    const npGradeEl = document.getElementById('npGrade');
    const mdbCard = (data.courses || []).find((c) => c.slug.includes('modern-databases'));
    const npCard = (data.courses || []).find((c) => c.slug.includes('network-programming'));

    if (mdbGradeEl && mdbCard?.grade != null) mdbGradeEl.textContent = `${mdbCard.grade}%`;
    if (npGradeEl && npCard?.grade != null) npGradeEl.textContent = `${npCard.grade}%`;
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
        await fetchAnswers();
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
      if (!confirm('Are you sure you want to stop the auto-solver?')) return;
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

    evtSource.addEventListener('log', (e) => {
      try {
        const { text } = JSON.parse(e.data);
        if (terminalOutput) {
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

    evtSource.addEventListener('run_start', () => {
      fetchStatus();
    });

    evtSource.addEventListener('run_end', () => {
      fetchStatus();
    });

    evtSource.addEventListener('answer_uploaded', () => {
      fetchAnswers();
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

  // Initial Data Load
  fetchStatus();
  fetchAnswers();
  initSSE();
});
