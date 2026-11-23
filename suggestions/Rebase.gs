/**
 * Bringing a pending suggestion up to date with what was accepted after it was written.
 *
 * Several readers can correct the same song at once. Nobody is locked out; each
 * suggestion records how many accepted corrections the song had when the reader opened
 * it (its "base"). Everything accepted since then is `landed`, and this file works out,
 * change by change, what `landed` did to the suggestion:
 *
 *   clean     still applies. Its address or expected text may have been adjusted.
 *   applied   the song already reads this way; there is nothing left to publish.
 *   conflict  the same line was changed to something else in the meantime.
 *
 * It needs no access to the lyrics. A change says what the reader saw at an address
 * (`old`), and every change to the song since then is in `landed`, so the line's present
 * reading follows from the two.
 *
 * Pure functions, no Apps Script services: web/src/lib/rebase.test.ts runs this file.
 */

/**
 * @param {Object[]} changes  One suggestion's changes, as stored (see cleanChange_).
 * @param {Object[]} landed   The song's accepted entries for the same script, in order,
 *                            from the suggestion's base onwards.
 * @param {boolean[]=} picked Which changes are to be published. Default: all. An added
 *                            line anchored on a line that the same suggestion corrects
 *                            expects the corrected text only if that correction is picked.
 * @return {Object[]} One per change: { status, change, current?, at?, samePlace? }.
 *   `change` is ready to publish when status is 'clean'. `current` is the line's present
 *   text when landed entries touched it (null: removed).
 */
function rebase_(changes, landed, picked) {
  const outcome = function (c) { return c.del ? null : c.new; };
  const sameLines = function (a, b) {
    return a.length === b.length && a.every(function (line, k) { return line === b[k]; });
  };

  // A reader's own correction to the line an added line is anchored on. Looked up by
  // the addresses as written, before anything below moves them.
  const own = changes.map(function (c) {
    if (!c.add) return -1;
    for (let k = 0; k < changes.length; k++) {
      const e = changes[k];
      if (!e.add && e.i === c.i && (e.n || 0) === (c.n || 0)) return k;
    }
    return -1;
  });

  const states = changes.map(function (c, index) {
    const anchorEdit = own[index] >= 0 ? changes[own[index]] : null;
    const state = {
      n: c.n || 0,
      // The line as the reader found it. For an added line, that is its anchor before
      // the reader's own correction to it.
      cur: c.add && anchorEdit ? anchorEdit.old : c.old,
      touched: false,
      at: '',
      samePlace: false,
      already: false,
    };
    landed.forEach(function (entry) {
      if (entry.i !== c.i) return;
      const n = entry.n || 0;
      if (entry.add) {
        if (state.n > n) {
          // Lines went in before this one: it moved down by that many.
          state.n += entry.add.length;
        } else if (state.n === n && c.add) {
          if (sameLines(entry.add, c.add)) state.already = true;
          else state.samePlace = true;
        }
        return;
      }
      // An entry applies only where the line reads as it expected; see lib/corrections.ts.
      if (n !== state.n || entry.old !== state.cur) return;
      state.cur = outcome(entry);
      state.touched = true;
      state.at = entry.at || '';
    });
    return state;
  });

  const statusOf = function (index) {
    const c = changes[index];
    const state = states[index];
    if (c.add) return state.already ? 'applied' : 'clean';
    if (state.cur === c.old) return 'clean';
    return state.cur === outcome(c) ? 'applied' : 'conflict';
  };

  return changes.map(function (c, index) {
    const state = states[index];
    const status = statusOf(index);
    const change = { i: c.i };
    if (state.n) change.n = state.n;

    if (c.add) {
      const anchor = own[index];
      const publishedWithAnchor = anchor >= 0 && statusOf(anchor) === 'clean' &&
        (!picked || picked[anchor] === true);
      change.old = publishedWithAnchor ? outcome(changes[anchor]) : state.cur;
      change.add = c.add.slice();
    } else {
      change.old = c.old;
      if (c.del) change.del = true;
      else change.new = c.new;
    }

    const out = { status: status, change: change };
    if (state.touched) {
      out.current = state.cur;
      out.at = state.at;
    }
    if (state.samePlace) out.samePlace = true;
    return out;
  });
}

/**
 * Where two pending suggestions want the same line to read differently.
 *
 * Both lists are rebase_ results for the same song and script, so their addresses are
 * comparable. Returns, for each change of `mine`, the other suggestion's version of that
 * line (`null`: remove it), or `undefined` where they do not compete.
 */
function competing_(mine, theirs) {
  return mine.map(function (m) {
    const a = m.change;
    if (a.add || m.status !== 'clean') return undefined;
    for (let k = 0; k < theirs.length; k++) {
      const b = theirs[k].change;
      if (b.add || theirs[k].status !== 'clean') continue;
      if (b.i !== a.i || (b.n || 0) !== (a.n || 0)) continue;
      const theirOutcome = b.del ? null : b.new;
      const myOutcome = a.del ? null : a.new;
      return theirOutcome === myOutcome ? undefined : theirOutcome;
    }
    return undefined;
  });
}
