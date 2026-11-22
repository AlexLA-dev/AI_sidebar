// The cookie closer's test pages (2.7.1): each consent platform's markup as the platform draws it (ids, classes,
// shadow roots, the first layer and its settings), and banners sites make themselves in ten languages. The unit tests
// load them into linkedom (tests/cookies.test.mts); tools/cookies/stand.mjs serves the same pages for real Safari.
//
// In a page: `data-act="hide"` on a button hides its banner ([data-banner]); `data-act="show:<selector>"` shows the
// element (the platform's settings). `data-expect` marks the button the closer must press; `expect` says what the
// closer must do ("done" with the platform, or "left" and why).

const fixed = "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#fff;padding:16px;box-shadow:0 -2px 12px #0003;font:15px system-ui"

const banner = (id, inner, extra = "") => `<div id="${id}" data-banner style="${fixed}" ${extra}>${inner}</div>`
const btn = (label, attrs = "", act = "hide") => `<button type="button" data-act="${act}" ${attrs}>${label}</button>`
const expectBtn = (label, attrs = "") => btn(label, `data-expect ${attrs}`)

export const PLATFORM_PAGES = [
  {
    name: "onetrust", expect: { status: "done", via: "onetrust" },
    html: `<div id="onetrust-consent-sdk"><div id="onetrust-banner-sdk" data-banner style="${fixed}">
      <p id="onetrust-policy-text">We use cookies to improve your experience and for marketing.</p>
      <div id="onetrust-button-group">${btn("Cookie Settings", 'id="onetrust-pc-btn-handler"', "none")}${expectBtn("Reject All", 'id="onetrust-reject-all-handler"')}${btn("Accept All Cookies", 'id="onetrust-accept-btn-handler"')}</div>
    </div></div>`
  },
  {
    name: "onetrust-settings", expect: { status: "done", via: "onetrust" },
    html: `<div id="onetrust-consent-sdk"><div id="onetrust-banner-sdk" data-banner style="${fixed}">
      <p id="onetrust-policy-text">This site uses cookies. By continuing you agree to our use of cookies.</p>
      <div id="onetrust-button-group">${btn("Cookie Settings", 'id="onetrust-pc-btn-handler"', "show:#onetrust-pc-sdk")}${btn("Accept All Cookies", 'id="onetrust-accept-btn-handler"')}</div>
    </div>
    <div id="onetrust-pc-sdk" data-banner hidden style="${fixed};top:20%">
      <h3>Privacy Preference Center</h3>
      <label>Strictly Necessary Cookies <input type="checkbox" class="category-switch-handler" checked disabled></label>
      <label>Performance Cookies <input type="checkbox" class="category-switch-handler" checked data-off-expect></label>
      <label>Targeting Cookies <input type="checkbox" class="category-switch-handler" checked data-off-expect></label>
      ${btn("Allow All", 'id="accept-recommended-btn-handler"')}${expectBtn("Confirm My Choices", 'class="save-preference-btn-handler onetrust-close-btn-handler"')}
    </div></div>`
  },
  {
    name: "cookiebot", expect: { status: "done", via: "cookiebot" },
    html: `<div id="CybotCookiebotDialog" data-banner role="dialog" style="${fixed}">
      <h2 id="CybotCookiebotDialogBodyContentTitle">This website uses cookies</h2>
      <div id="CybotCookiebotDialogBodyText">We use cookies to personalise content and ads, to provide social media features and to analyse our traffic.</div>
      ${expectBtn("Use necessary cookies only", 'id="CybotCookiebotDialogBodyButtonDecline"')}${btn("Allow selection", 'id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection"')}${btn("Allow all cookies", 'id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"')}
    </div>`
  },
  {
    name: "didomi", expect: { status: "done", via: "didomi" },
    html: `<div id="didomi-host"><div id="didomi-notice" data-banner class="didomi-notice-banner" style="${fixed}">
      <div class="didomi-notice-text">Nous et nos partenaires utilisons des cookies et technologies similaires pour stocker et accéder à des informations sur votre appareil.</div>
      ${btn("En savoir plus", 'id="didomi-notice-learn-more-button"', "none")}<a href="#" class="didomi-continue-without-agreeing" data-act="hide" data-expect>Continuer sans accepter →</a>${btn("Accepter &amp; Fermer", 'id="didomi-notice-agree-button"')}
    </div></div>`
  },
  {
    name: "didomi-settings", expect: { status: "done", via: "didomi" },
    html: `<div id="didomi-host"><div id="didomi-notice" data-banner style="${fixed}">
      <div class="didomi-notice-text">We and our partners use cookies to store and access personal data such as browsing data.</div>
      ${btn("Learn more", 'id="didomi-notice-learn-more-button"', "show:#didomi-popup")}${btn("Agree and close", 'id="didomi-notice-agree-button"')}
    </div>
    <div id="didomi-popup" data-banner hidden class="didomi-popup" style="${fixed};top:15%">
      <div class="didomi-consent-popup-header">Your consent choices</div>
      <div class="didomi-consent-popup-actions">${expectBtn("Disagree to all")}${btn("Agree to all")}</div>
    </div></div>`
  },
  {
    name: "quantcast", expect: { status: "done", via: "quantcast" },
    html: `<div id="qc-cmp2-container" class="qc-cmp2-container" data-banner><div class="qc-cmp2-summary-section" style="${fixed}">
      <p class="qc-cmp2-summary-info">We value your privacy. We and our partners store and/or access information on a device, such as cookies.</p>
      <div class="qc-cmp2-summary-buttons">${btn("MORE OPTIONS", 'mode="secondary"', "none")}${expectBtn("DISAGREE", 'mode="secondary"')}${btn("AGREE", 'mode="primary"')}</div>
    </div></div>`
  },
  {
    name: "trustarc", expect: { status: "done", via: "trustarc" },
    html: `<div id="truste-consent-track" data-banner style="${fixed}">
      <div id="truste-consent-content">We use cookies and similar technologies to understand how you use our site.</div>
      <div id="truste-consent-buttons">${expectBtn("Required Only", 'id="truste-consent-required"')}${btn("Accept All", 'id="truste-consent-button"')}${btn("Cookie Preferences", 'id="truste-show-consent"', "none")}</div>
    </div>`
  },
  {
    name: "usercentrics", expect: { status: "done", via: "usercentrics" },
    shadow: {
      host: "usercentrics-root",
      html: `<div data-banner style="${fixed}"><p>Wir verwenden Cookies und ähnliche Technologien. Ihre Einwilligung ist freiwillig.</p>
        ${btn("Einstellungen", 'data-testid="uc-more-button"', "none")}${expectBtn("Ablehnen", 'data-testid="uc-deny-all-button"')}${btn("Alle akzeptieren", 'data-testid="uc-accept-all-button"')}</div>`
    },
    html: `<div id="usercentrics-root"></div>`
  },
  {
    name: "cookieyes", expect: { status: "done", via: "cookieyes" },
    html: `<div class="cky-consent-container cky-banner-bottom" data-banner style="${fixed}"><div class="cky-consent-bar">
      <p class="cky-title">We value your privacy</p><div class="cky-notice-des">We use cookies to enhance your browsing experience.</div>
      <div class="cky-notice-btn-wrapper">${btn("Customize", 'class="cky-btn cky-btn-customize"', "none")}${expectBtn("Reject All", 'class="cky-btn cky-btn-reject"')}${btn("Accept All", 'class="cky-btn cky-btn-accept"')}</div>
    </div></div>`
  },
  {
    name: "complianz", expect: { status: "done", via: "complianz" },
    html: `<div id="cmplz-cookiebanner-container"><div class="cmplz-cookiebanner cmplz-show" data-banner role="dialog" style="${fixed}">
      <div class="cmplz-message">Utilizziamo i cookie per ottimizzare il nostro sito web e il nostro servizio.</div>
      <div class="cmplz-buttons">${btn("Accetta", 'class="cmplz-btn cmplz-accept"')}${expectBtn("Nega", 'class="cmplz-btn cmplz-deny"')}${btn("Visualizza le preferenze", 'class="cmplz-btn cmplz-view-preferences"', "none")}</div>
    </div></div>`
  },
  {
    name: "iubenda", expect: { status: "done", via: "iubenda" },
    html: `<div id="iubenda-cs-banner" data-banner role="alertdialog" style="${fixed}"><div class="iubenda-cs-container">
      ${btn("×", 'class="iubenda-cs-close-btn" aria-label="Chiudi"')}
      <div id="iubenda-cs-paragraph">Noi e terze parti selezionate utilizziamo cookie o tecnologie simili per finalità tecniche e, con il tuo consenso, anche per altre finalità.</div>
      <div class="iubenda-cs-opt-group">${btn("Scopri di più e personalizza", 'class="iubenda-cs-customize-btn"', "none")}${expectBtn("Rifiuta", 'class="iubenda-cs-reject-btn"')}${btn("Accetta", 'class="iubenda-cs-accept-btn"')}</div>
    </div></div>`
  },
  {
    name: "osano", expect: { status: "done", via: "osano" },
    html: `<div class="osano-cm-window"><div class="osano-cm-dialog osano-cm-dialog--position_bottom" data-banner role="dialog" style="${fixed}">
      <span class="osano-cm-message">This website utilizes technologies such as cookies to enable essential site functionality, as well as for analytics.</span>
      <div class="osano-cm-dialog__buttons">${btn("Manage Preferences", 'class="osano-cm-button osano-cm-manage"', "none")}${expectBtn("Deny", 'class="osano-cm-button osano-cm-denyAll"')}${btn("Accept", 'class="osano-cm-button osano-cm-accept-all"')}</div>
    </div></div>`
  },
  {
    name: "termly", expect: { status: "done", via: "termly" },
    html: `<div id="termly-code-snippet-support"><div role="dialog" data-banner style="${fixed}">
      <div>We use essential cookies to make our site work. With your consent, we may also use non-essential cookies.</div>
      ${btn("Preferences", 'data-tid="banner-preferences"', "none")}${expectBtn("Decline", 'data-tid="banner-decline" class="t-declineButton"')}${btn("Accept", 'data-tid="banner-accept"')}
    </div></div>`
  },
  {
    name: "klaro", expect: { status: "done", via: "klaro" },
    html: `<div class="klaro"><div class="cookie-notice" data-banner role="dialog" style="${fixed}">
      <div class="cn-body"><p>Hi! Could we please enable some additional services for Analytics and Security? You can always change or withdraw your consent later.</p>
      <div class="cn-ok">${btn("Let me choose", 'class="cn-learn-more"', "none")}<div class="cn-buttons">${expectBtn("I decline", 'class="cm-btn cm-btn-danger cn-decline"')}${btn("That's ok", 'class="cm-btn cm-btn-success"')}</div></div></div>
    </div></div>`
  },
  {
    name: "consentmanager", expect: { status: "done", via: "consentmanager" },
    html: `<div id="cmpbox" class="cmpbox" data-banner style="${fixed}"><div class="cmpboxinner">
      <div class="cmpboxtxt">Wir benötigen Ihre Zustimmung zur Verwendung der einzelnen Daten und Cookies.</div>
      <div class="cmpboxbtns"><a class="cmpboxbtn cmpboxbtnyes" href="#" data-act="hide">Alle akzeptieren</a><a class="cmpboxbtn cmpboxbtnno" href="#" data-act="hide" data-expect>Ablehnen</a></div>
    </div></div>`
  },
  {
    name: "axeptio", expect: { status: "done", via: "axeptio" },
    html: `<div id="axeptio_overlay"><div class="axeptio_mount"><div class="axeptio_widget" data-banner style="${fixed}">
      <p>Ce site utilise des cookies pour mesurer l'audience et personnaliser le contenu.</p>
      ${expectBtn("Non merci", 'id="axeptio_btn_dismiss"')}${btn("Je choisis", 'id="axeptio_btn_configure"', "none")}${btn("OK pour moi", 'id="axeptio_btn_acceptAll"')}
    </div></div></div>`
  },
  {
    name: "funding-choices", expect: { status: "done", via: "funding_choices" },
    html: `<div class="fc-consent-root"><div class="fc-dialog-container" data-banner style="${fixed}">
      <h1 class="fc-dialog-headline">This site asks for consent to use your data</h1>
      <div class="fc-footer-buttons">${expectBtn("Do not consent", 'class="fc-button fc-cta-do-not-consent"')}${btn("Consent", 'class="fc-button fc-cta-consent"')}${btn("Manage options", 'class="fc-button fc-cta-manage-options"', "none")}</div>
    </div></div>`
  },
  {
    name: "funding-choices-settings", expect: { status: "done", via: "funding_choices" },
    html: `<div class="fc-consent-root"><div class="fc-dialog-container" id="fc-first" data-banner style="${fixed}">
      <h1 class="fc-dialog-headline">This site asks for consent to use your data</h1>
      <div class="fc-footer-buttons">${btn("Consent", 'class="fc-button fc-cta-consent"')}${btn("Manage options", 'class="fc-button fc-cta-manage-options"', "show:#fc-prefs")}</div>
    </div><div class="fc-dialog-container" id="fc-prefs" data-banner hidden style="${fixed};top:10%">
      <h2>Manage your data</h2>${expectBtn("Confirm choices", 'class="fc-button fc-confirm-choices"')}${btn("Accept all", 'class="fc-button fc-data-preferences-accept-all"')}
    </div></div>`
  },
  {
    // A TCF platform we have no rule for: its API's frame on the page, a dialog that says «privacy», not «cookie».
    name: "tcf", expect: { status: "done", via: "tcf" },
    html: `<iframe name="__tcfapiLocator" style="display:none"></iframe><div class="some-cmp-dialog" data-banner role="dialog" style="${fixed}">
      <p>We value your privacy. We and our 842 partners store and access personal data, like browsing data or unique identifiers, on your device.</p>
      ${btn("Accept all")}${expectBtn("Reject all")}${btn("Show purposes", "", "none")}
    </div>`
  },
  {
    // The only answer offered is «OK»: left to the person.
    name: "onetrust-accept-only", expect: { status: "left", why: "only_accept", via: "onetrust" },
    html: `<div id="onetrust-consent-sdk"><div id="onetrust-banner-sdk" data-banner style="${fixed}">
      <p id="onetrust-policy-text">By using this site you agree to our use of cookies.</p>
      <div id="onetrust-button-group">${btn("OK", 'id="onetrust-accept-btn-handler"')}</div>
    </div></div>`
  }
]

// Banners sites make themselves, in ten languages: [lang, text, reject, accept, settings].
const GENERIC = [
  ["en", "We use cookies to give you the best experience. You can accept all cookies or reject the non-essential ones.", "Reject non-essential", "Accept all", "Manage settings"],
  ["ru", "Мы используем файлы cookie, чтобы сайт работал лучше. Вы можете принять все или оставить только необходимые.", "Только необходимые", "Принять все", "Настроить"],
  ["de", "Wir verwenden Cookies, um unsere Website für Sie optimal zu gestalten.", "Nur notwendige Cookies", "Alle akzeptieren", "Einstellungen"],
  ["fr", "Ce site utilise des cookies pour améliorer votre expérience de navigation.", "Tout refuser", "Tout accepter", "Personnaliser"],
  ["es", "Utilizamos cookies propias y de terceros para mejorar nuestros servicios.", "Rechazar todas", "Aceptar todas", "Configurar"],
  ["it", "Questo sito utilizza cookie tecnici e, previo consenso, cookie di profilazione.", "Rifiuta tutti", "Accetta tutti", "Personalizza"],
  ["tr", "Size daha iyi bir deneyim sunmak için çerezler kullanıyoruz.", "Tümünü reddet", "Tümünü kabul et", "Ayarlar"],
  ["ar", "نستخدم ملفات تعريف الارتباط لتحسين تجربتك على موقعنا.", "رفض الكل", "قبول الكل", "الإعدادات"],
  ["ja", "当サイトではCookieを使用して、サービスの向上と広告の配信を行っています。", "必須のみ", "すべて同意する", "設定"],
  ["zh", "我们使用Cookie来改善您的浏览体验并提供个性化内容。", "全部拒绝", "全部接受", "设置"]
]

export const GENERIC_PAGES = [
  ...GENERIC.map(([lang, text, reject, accept, settings]) => ({
    name: `generic-${lang}`, lang, expect: { status: "done", via: "generic" },
    html: banner(`site-cookie-${lang}`, `<p>${text}</p>${btn(settings, "", "none")}${expectBtn(reject)}${btn(accept)}`, `class="site-notice" dir="${lang === "ar" ? "rtl" : "ltr"}"`)
  })),
  // Only «Accept» (and maybe settings): nothing pressed, nothing hidden.
  {
    name: "generic-accept-only-en", lang: "en", expect: { status: "left", why: "only_accept", via: "generic" },
    html: banner("notice-en", `<p>This website uses cookies to ensure you get the best experience.</p>${btn("Got it!")}<a href="/privacy">Learn more</a>`)
  },
  {
    name: "generic-accept-only-ru", lang: "ru", expect: { status: "left", why: "only_accept", via: "generic" },
    html: banner("notice-ru", `<p>Продолжая пользоваться сайтом, вы соглашаетесь на использование файлов cookie.</p>${btn("Принять")}${btn("Настройки", "", "none")}`)
  },
  // The reject is a link to another page: never followed.
  {
    name: "generic-reject-link", lang: "en", expect: { status: "left", why: "only_accept", via: "generic" },
    html: banner("notice-link", `<p>We use cookies for analytics.</p><a href="https://example.org/opt-out">Reject</a>${btn("Accept")}`)
  },
  // A sign-in dialog that mentions cookies: never touched.
  {
    name: "generic-login", lang: "en", expect: { status: "none" },
    html: `<div role="dialog" data-banner style="${fixed}"><p>Sign in. We use cookies to keep you signed in.</p><form><input type="email"><input type="password">${btn("Decline")}<button type="submit">Sign in</button></form></div>`
  },
  // «Manage or reject cookies» opens settings: not a reject, so only «Accept» is left — the person's choice.
  {
    name: "generic-manage-or-reject", lang: "en", expect: { status: "left", why: "only_accept", via: "generic" },
    html: banner("notice-manage", `<p>We use cookies.</p>${btn("Yes, I'm happy")}${btn("Manage or reject cookies", "", "none")}`)
  },
  // A page about cookies (a policy), nothing floating: not a banner.
  {
    name: "generic-policy-page", lang: "en", expect: { status: "none" },
    html: `<main><h1>Cookie policy</h1><p>This page explains which cookies we use and how you can reject them in your browser.</p>${btn("Reject all")}</main>`
  }
]

export const PAGES = [...PLATFORM_PAGES, ...GENERIC_PAGES]

/** The pages' own behaviour, for real browsers (the tests apply the same rules themselves). */
export const PAGE_SCRIPT = `
document.addEventListener("click", function (e) {
  var t0 = (e.composedPath && e.composedPath()[0]) || e.target;
  var b = t0 && t0.closest && t0.closest("[data-act]");
  if (!b) return;
  var act = b.getAttribute("data-act");
  (window.__pressed = window.__pressed || []).push((b.textContent || "").trim());
  var out = document.getElementById("pressed"); if (out) out.textContent = "pressed: " + window.__pressed.join(" → ");
  if (act === "hide") { var banner = b.closest("[data-banner]"); var all = b.closest("#onetrust-consent-sdk, #didomi-host, .fc-consent-root"); (all ? all.querySelectorAll("[data-banner]") : [banner]).forEach(function (x) { x && (x.hidden = true, x.style.display = "none"); }); }
  if (act.indexOf("show:") === 0) { var t = document.querySelector(act.slice(5)); if (t) { t.hidden = false; t.style.display = ""; } }
  e.preventDefault();
}, true);
`
