// Word Error Rate between a hypothesis (our ASR transcript) and a reference (client standard).
function norm(s) {
  return (s.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').match(/\S+/g) || []);
}

export function wer(hypText, refText) {
  const h = norm(hypText);
  const r = norm(refText);
  const n = r.length;
  const m = h.length;
  // word-level Levenshtein
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = r[i - 1] === h[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const edits = dp[n][m];
  const alignment = [];
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && r[i - 1] === h[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      alignment.push({ op: 'match', ref: r[i - 1], hyp: h[j - 1] });
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      alignment.push({ op: 'substitute', ref: r[i - 1], hyp: h[j - 1] });
      substitutions++;
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      alignment.push({ op: 'delete', ref: r[i - 1], hyp: '' });
      deletions++;
      i--;
    } else {
      alignment.push({ op: 'insert', ref: '', hyp: h[j - 1] });
      insertions++;
      j--;
    }
  }
  alignment.reverse();
  return {
    reference_words: n,
    hypothesis_words: m,
    edits,
    substitutions,
    deletions,
    insertions,
    wer: n ? edits / n : 0,
    word_agreement: n ? Math.max(0, 1 - edits / n) : 1,
    alignment,
  };
}
