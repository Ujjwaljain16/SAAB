import React, { useState, useEffect } from 'react';
import { ReferenceAnswer } from '../../types';
import { referenceEngine } from '../../core/reference-engine';

export const ReferenceTab: React.FC = () => {
  const [query, setQuery] = useState('');
  const [selectedCourse, setSelectedCourse] = useState('all');
  const [references, setReferences] = useState<ReferenceAnswer[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    referenceEngine.init().then(() => {
      setReferences(referenceEngine.getAll());
      setIsLoading(false);
    });
  }, []);

  const filtered = references.filter((r) => {
    const matchesCourse =
      selectedCourse === 'all' ||
      (r.course && r.course.toLowerCase().includes(selectedCourse.toLowerCase())) ||
      (r.source && r.source.toLowerCase().includes(selectedCourse.toLowerCase()));

    const matchesQuery =
      !query ||
      r.prompt.toLowerCase().includes(query.toLowerCase()) ||
      r.correctAnswers.some((a) => a.toLowerCase().includes(query.toLowerCase()));

    return matchesCourse && matchesQuery;
  });

  return (
    <div>
      <div style={{ marginBottom: '12px' }}>
        <input
          type="text"
          className="text-input"
          placeholder="Search question, keyword, or answer..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* Course filter pills */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', overflowX: 'auto' }}>
        {[
          { id: 'all', label: `All (${references.length})` },
          { id: 'modern_db', label: 'Modern DB' },
          { id: 'sdp', label: 'SDP' },
          { id: 'npcsp', label: 'Network Prog' }
        ].map((c) => (
          <button
            key={c.id}
            onClick={() => setSelectedCourse(c.id)}
            style={{
              padding: '4px 10px',
              borderRadius: '12px',
              fontSize: '11px',
              fontWeight: '600',
              border: 'none',
              cursor: 'pointer',
              background: selectedCourse === c.id ? 'rgba(139, 92, 246, 0.25)' : 'rgba(255, 255, 255, 0.05)',
              color: selectedCourse === c.id ? '#c4b5fd' : 'var(--text-muted)'
            }}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Results List */}
      {isLoading ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px' }}>
          Loading reference keys...
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px' }}>
          No reference answers found matching your search.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '420px', overflowY: 'auto' }}>
          {filtered.slice(0, 30).map((r, i) => (
            <div key={r.id || i} className="glass-card" style={{ marginBottom: 0, padding: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '10px', color: 'var(--accent-purple)', fontWeight: '700' }}>
                  {r.source || 'Verified Key'}
                </span>
                <span className="status-pill success" style={{ fontSize: '9px', padding: '1px 6px' }}>
                  Verified
                </span>
              </div>
              <div style={{ fontSize: '12px', color: '#e2e8f0', marginBottom: '6px', lineHeight: '1.4' }}>
                {r.prompt}
              </div>
              <div style={{ background: 'rgba(16, 185, 129, 0.08)', padding: '6px 8px', borderRadius: '4px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                <span style={{ fontSize: '10px', color: 'var(--accent-emerald)', fontWeight: '700' }}>Answer: </span>
                <span style={{ fontSize: '11px', color: '#f8fafc', fontWeight: '600' }}>
                  {r.correctAnswers.join('  •  ')}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
