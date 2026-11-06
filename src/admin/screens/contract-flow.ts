// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

/**
 * CMS の中の契約(cms-pricing「CMS からの申し込みと本人」2 節・2026-11-06)。申し込み・解約はこの窓で行う。
 * 持ち主の管理者だけが押せる。お金と削除の操作は、押す直前に CMS のパスキーで確かめ直す(サーバーが reauth_required で断る)。
 * 文面(最終確認・解約の内容)は Billing が組むものをそのまま出す。カードは決済サービスの画面でだけ扱う。
 */
type ContractItem = { label: string; text: string };

async function reauthPasskey() {
  const begin = await api("/api/auth/passkey/login/begin", {
    method: "POST",
    body: "{}",
  });
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: b64uDecode(begin.challenge),
      rpId: begin.rpId,
      userVerification: "required",
      timeout: 60000,
    },
  });
  await api("/api/auth/passkey/login/complete", {
    method: "POST",
    body: JSON.stringify({
      challengeId: begin.challengeId,
      credential: serializeCredentialForAuthentication(
        credential as PublicKeyCredential,
      ),
    }),
  });
}

/** 契約の操作を送る。確かめ直しを求められたら、パスキーで確かめて 1 度だけ送り直す。 */
async function contractCall(action: string, body: Dynamic = {}) {
  return ownerPost("/api/system/contract/" + action, body);
}

async function ownerPost(path: string, body: Dynamic) {
  const send = () =>
    api(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  try {
    return await send();
  } catch (err) {
    if ((err as Dynamic)?.code !== "reauth_required") throw err;
    await reauthPasskey();
    return await send();
  }
}

function contractIdemKey() {
  return "cms-" + crypto.randomUUID();
}

function contractDialog(title: string) {
  const ov = document.createElement("div");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.style.cssText =
    "position:fixed;inset:0;z-index:3000;background:rgba(8,12,22,.72);display:flex;align-items:center;justify-content:center;padding:20px";
  const card = document.createElement("div");
  card.style.cssText =
    "width:min(600px,100%);max-height:90vh;overflow:auto;background:var(--panel,#141f35);color:var(--ink,#e9eefc);border:1px solid var(--line,#293b5d);border-radius:14px;padding:22px";
  const h = document.createElement("h3");
  h.style.cssText = "margin:0 0 12px";
  h.textContent = title;
  const body = document.createElement("div");
  const msg = document.createElement("p");
  msg.setAttribute("role", "status");
  msg.style.cssText = "margin:12px 0 0;font-size:13px";
  card.append(h, body, msg);
  ov.appendChild(card);
  document.body.appendChild(ov);
  return {
    body,
    close: () => ov.remove(),
    title: (text: string) => {
      h.textContent = text;
    },
    say: (text: string, error = false) => {
      msg.textContent = text;
      msg.style.color = error ? "var(--danger,#ef4444)" : "";
    },
  };
}

function contractItems(items: ContractItem[]) {
  const dl = document.createElement("dl");
  dl.style.cssText = "margin:0 0 12px;font-size:13px;line-height:1.7";
  for (const item of items) {
    const dt = document.createElement("dt");
    dt.style.cssText = "font-weight:600;margin-top:8px";
    dt.textContent = item.label;
    const dd = document.createElement("dd");
    dd.style.cssText = "margin:0";
    dd.textContent = item.text;
    dl.append(dt, dd);
  }
  return dl;
}

function contractButton(label: string, kind = "") {
  const b = document.createElement("button");
  b.type = "button";
  if (kind) b.className = kind;
  b.textContent = label;
  return b;
}

function contractRow(...items: HTMLElement[]) {
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:12px";
  row.append(...items);
  return row;
}

function contractMoney(currency: string, minor: number) {
  const zero = ["JPY", "KRW"].includes(String(currency).toUpperCase());
  return new Intl.NumberFormat(state.uiLang || undefined, {
    style: "currency",
    currency,
  }).format(zero ? minor : minor / 100);
}

function contractAgree(label: string, target: HTMLButtonElement) {
  const wrap = document.createElement("label");
  wrap.style.cssText =
    "display:flex;gap:8px;align-items:flex-start;font-size:13px;margin-top:8px";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.style.cssText = "width:auto;margin-top:3px";
  target.disabled = true;
  check.onchange = () => {
    target.disabled = !check.checked;
  };
  wrap.append(check, document.createTextNode(label));
  return wrap;
}

/** 契約の窓を開く。契約があれば内容と解約、無ければ(解約済みも)申し込み。 */
async function openContractWindow(onChange: () => void = () => {}) {
  const win = contractDialog(t("contractWindowTitle"));
  const lang = state.uiLang === "ja" ? "ja" : "en";
  const fail = (err: unknown) =>
    win.say(errorMessage(err) || t("apiFailed"), true);
  const closeBtn = () => {
    const b = contractButton(t("contractWindowClose"), "secondary");
    b.onclick = win.close;
    return b;
  };

  async function offer(lead: string) {
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 10px;font-size:14px;line-height:1.7";
    p.textContent = lead;
    win.body.appendChild(p);
    const cat = await api("/api/system/contract/catalog");
    const prices = ((cat.prices || []) as Dynamic[]).filter(
      (x) => x.sale === "recurring",
    );
    if (!prices.length) {
      win.say(t("contractNoPrices"), true);
      win.body.appendChild(contractRow(closeBtn()));
      return;
    }
    let chosen = prices[0];
    for (const x of prices) {
      const label = document.createElement("label");
      label.style.cssText =
        "display:flex;gap:8px;align-items:center;font-size:14px;margin:6px 0";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "contractPrice";
      radio.style.cssText = "width:auto";
      radio.checked = x === chosen;
      radio.onchange = () => {
        chosen = x;
      };
      label.append(
        radio,
        document.createTextNode(
          (x.period === "year"
            ? t("contractPlanYear")
            : t("contractPlanMonth")) +
            "  " +
            contractMoney(x.currency, x.amount_minor),
        ),
      );
      win.body.appendChild(label);
    }
    const go = contractButton(t("contractNext"));
    go.onclick = async () => {
      go.disabled = true;
      win.say("");
      try {
        const c = await contractCall("start", {
          price_id: chosen.price_id,
          lang,
          idempotency_key: contractIdemKey(),
        });
        confirmStep(c);
      } catch (err) {
        go.disabled = false;
        fail(err);
      }
    };
    win.body.appendChild(contractRow(closeBtn(), go));
  }

  function confirmStep(c: Dynamic) {
    win.title(t("contractConfirmTitle"));
    win.body.textContent = "";
    win.body.appendChild(contractItems(c.confirmation?.items ?? []));
    if (c.test_billing) {
      const note = document.createElement("p");
      note.className = "muted";
      note.style.cssText = "font-size:13px";
      note.textContent = t("contractTestCard");
      win.body.appendChild(note);
    }
    const preSale = c.sale_open === false;
    if (preSale) {
      const note = document.createElement("p");
      note.className = "muted";
      note.style.cssText = "font-size:13px";
      note.textContent = t("contractPreSale");
      win.body.appendChild(note);
    }
    const go = contractButton(t("contractProceed"));
    win.body.appendChild(contractAgree(t("contractAgree"), go));
    go.onclick = async () => {
      go.disabled = true;
      win.say(t("contractRedirecting"));
      try {
        const r = await contractCall("confirm", {
          intent_id: c.intent_id,
          state: c.state,
          confirmation_hash: c.confirmation_hash,
          terms_version: c.terms_version,
          privacy_version: c.privacy_version,
          idempotency_key: contractIdemKey(),
        });
        // 戻ってきた時の案内のためだけの印(契約の判断には使わない)。残せなくても案内が変わるだけ。
        try {
          if (preSale) sessionStorage.setItem("contractPreSale", "1");
          else sessionStorage.removeItem("contractPreSale");
        } catch {
          /* 残せない環境 */
        }
        // 決済サービスの画面へ。カードはそこでだけ扱う。送り先は Billing が返した URL だけ。
        location.assign(r.redirect_url);
      } catch (err) {
        go.disabled = false;
        fail(err);
      }
    };
    win.body.appendChild(contractRow(closeBtn(), go));
  }

  async function cancelStep(contractId: string, currency: string) {
    const q = await contractCall("cancel-quote", {
      contract_id: contractId,
      lang,
    });
    win.title(t("contractCancelTitle"));
    win.body.textContent = "";
    win.body.appendChild(contractItems(q.content?.items ?? []));
    const go = contractButton(t("contractCancelConfirm"), "danger");
    win.body.appendChild(contractAgree(t("contractCancelAgree"), go));
    go.onclick = async () => {
      go.disabled = true;
      win.say(t("contractCancelling"));
      try {
        const done = await contractCall("cancel", {
          contract_id: contractId,
          quote_id: q.quote_id,
          state: q.state,
          content_hash: q.content_hash,
          idempotency_key: contractIdemKey(),
        });
        await api("/api/system/contract/sync", {
          method: "POST",
          body: "{}",
        }).catch(() => {});
        win.body.textContent = "";
        const p = document.createElement("p");
        p.style.cssText = "font-size:14px;line-height:1.7";
        p.textContent =
          t("contractCancelDone") +
          (done.refund_minor > 0
            ? " " +
              t("contractRefundNote").replace(
                "{amount}",
                contractMoney(currency, done.refund_minor),
              )
            : "");
        win.body.append(p, contractRow(closeBtn()));
        win.say("");
        onChange();
      } catch (err) {
        go.disabled = false;
        fail(err);
      }
    };
    win.body.appendChild(contractRow(closeBtn(), go));
  }

  try {
    const r = await api("/api/system/contract/subscriptions");
    const list = (r.subscriptions || []) as Dynamic[];
    const lives = list.filter((s) =>
      [
        "active",
        "trialing",
        "past_due",
        "pending",
        "cancel_at_period_end",
      ].includes(s.state),
    );
    const live =
      lives.find((s) => s.state !== "cancel_at_period_end") ?? lives[0];
    if (live?.state !== "cancel_at_period_end" && live) {
      const items: ContractItem[] = [
        {
          label: t("contractPlan"),
          text:
            live.period === "year"
              ? t("contractPlanYear")
              : t("contractPlanMonth"),
        },
      ];
      if (live.amount_minor != null)
        items.push({
          label: t("contractPrice"),
          text: contractMoney(live.currency, live.amount_minor),
        });
      win.body.appendChild(contractItems(items));
      const row: HTMLElement[] = [closeBtn()];
      if (live.cancellable) {
        const c = contractButton(t("contractCancel"), "danger-soft");
        c.onclick = () => {
          c.disabled = true;
          win.say("");
          void cancelStep(live.contract_id, live.currency).catch((err) => {
            c.disabled = false;
            fail(err);
          });
        };
        row.push(c);
      }
      win.body.appendChild(contractRow(...row));
    } else {
      await offer(
        live ? t("contractResumeLead") : t("contractApplyWindowLead"),
      );
    }
  } catch (err) {
    fail(err);
    win.body.appendChild(contractRow(closeBtn()));
  }
}

/** 委託のサイトを消す(確かめの後)。消し始めたらこの管理画面も使えなくなるので、そう伝える。 */
async function deleteManagedSite(done: () => void) {
  await contractCall("delete");
  done();
}

/** 持ち主のアドレスの変更の窓(cms-pricing 4 節)。確認のメールを開くと、Entamy ID と CMS の両方が変わる。 */
function openOwnerEmailChange() {
  const win = contractDialog(t("ownerEmailChangeTitle"));
  const lead = document.createElement("p");
  lead.style.cssText = "margin:0 0 10px;font-size:14px;line-height:1.7";
  lead.textContent = t("ownerEmailChangeLead");
  const input = document.createElement("input");
  input.type = "email";
  input.autocomplete = "email";
  input.placeholder = "name@example.com";
  const close = contractButton(t("contractWindowClose"), "secondary");
  close.onclick = win.close;
  const go = contractButton(t("ownerEmailChangeSend"));
  go.onclick = async () => {
    if (!input.reportValidity() || !input.value.trim()) return;
    go.disabled = true;
    win.say("");
    try {
      await ownerPost("/api/system/owner-email", {
        email: input.value.trim(),
        lang: state.uiLang === "ja" ? "ja" : "en",
      });
      win.body.textContent = "";
      const done = document.createElement("p");
      done.style.cssText = "font-size:14px;line-height:1.7";
      done.textContent = t("ownerEmailChangeSent").replace(
        "{email}",
        input.value.trim(),
      );
      win.body.append(done, contractRow(close));
    } catch (err) {
      go.disabled = false;
      win.say(errorMessage(err) || t("apiFailed"), true);
    }
  };
  win.body.append(lead, input, contractRow(close, go));
  input.focus();
}
