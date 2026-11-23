// Consent platforms the cookie closer knows by their own markup (2.7.1). Each one's own «reject all» first; when the
// first layer has none, its settings opened and saved with only what's necessary (the optional switches turned off
// there first). Our own rules, written from the platforms' public markup (no third-party rule files are bundled).
//
// A step is a list of selectors (the first one there and shown is pressed), or "reject" / "save": a button inside
// the platform's window whose label says so, in any of our languages (src/shared/cookies/words.ts).

export type Step = readonly string[] | "reject" | "save"

export interface Rule {
  id: string
  // The platform's window on the page: shown means it asks now (its markup often stays after an answer, hidden).
  root: string
  // The window lives in this element's open shadow root.
  shadow?: string
  // Its own «reject all» / «only necessary» buttons.
  reject: readonly string[]
  // No reject on the first layer: open the settings, turn the optional switches off, then save or reject there.
  settings?: { open: readonly string[]; off?: string; then: readonly Step[] }
  // The buttons are outside `root` (in the document).
  wide?: boolean
}

export const RULES: readonly Rule[] = [
  {
    id: "onetrust",
    root: "#onetrust-banner-sdk, #onetrust-pc-sdk",
    wide: true,
    reject: ["#onetrust-reject-all-handler", "#onetrust-pc-sdk .ot-pc-refuse-all-handler", ".ot-pc-refuse-all-handler"],
    settings: {
      open: ["#onetrust-pc-btn-handler", ".ot-sdk-show-settings"],
      off: "#onetrust-pc-sdk input.category-switch-handler, #onetrust-pc-sdk .ot-switch input[type=checkbox]",
      then: [[".ot-pc-refuse-all-handler"], ["#onetrust-pc-sdk .save-preference-btn-handler", "#onetrust-pc-sdk button.ot-pc-save-btn"]]
    }
  },
  {
    id: "cookiebot",
    root: "#CybotCookiebotDialog",
    reject: [
      "#CybotCookiebotDialogBodyButtonDecline", "#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll",
      "[data-cookiebot-decline]", "#CybotCookiebotDialogBodyButtonDeclineAll"
    ],
    settings: {
      open: ["#CybotCookiebotDialogBodyLevelButtonCustomize", "#CybotCookiebotDialogNavDetails"],
      off: "#CybotCookiebotDialog input[type=checkbox]",
      then: [["#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection", "#CybotCookiebotDialogBodyButtonAcceptSelected"]]
    }
  },
  {
    id: "didomi",
    root: "#didomi-host #didomi-notice, #didomi-notice, #didomi-popup .didomi-popup-container, #didomi-consent-popup .didomi-popup-container, #didomi-host .didomi-popup-container",
    wide: true,
    reject: ["#didomi-notice-disagree-button", ".didomi-continue-without-agreeing", "#didomi-popup [aria-label^='Disagree' i]"],
    settings: {
      open: ["#didomi-notice-learn-more-button", ".didomi-learn-more-button"],
      then: ["reject", "save"]
    }
  },
  {
    id: "quantcast",
    root: "#qc-cmp2-ui, .qc-cmp2-container [role=dialog], .qc-cmp2-container .qc-cmp2-summary-section",
    reject: [".qc-cmp2-summary-buttons button[mode=secondary][aria-label*='DISAGREE' i]", ".qc-cmp2-buttons-desktop button[aria-label*='REJECT' i]"],
    settings: {
      open: [".qc-cmp2-summary-buttons button:first-child", "button[aria-label*='MORE OPTIONS' i]"],
      then: ["reject", "save"]
    }
  },
  {
    id: "trustarc",
    root: "#truste-consent-track, #consent_blackbar, .truste_box_overlay",
    wide: true,
    reject: ["#truste-consent-required", ".truste-consent-required", "#truste-consent-required2"]
  },
  {
    id: "usercentrics",
    root: "#usercentrics-root",
    shadow: "#usercentrics-root",
    reject: ["[data-testid=uc-deny-all-button]", "button[data-testid=uc-deny-all-button]"],
    settings: {
      open: ["[data-testid=uc-more-button]"],
      then: [["[data-testid=uc-deny-all-button]", "[data-testid=uc-save-button]"]]
    }
  },
  {
    id: "usercentrics",
    root: "#usercentrics-cmp-ui",
    shadow: "#usercentrics-cmp-ui",
    reject: ["#deny", "button.deny", "[data-action-type=deny]", "button.uc-deny-button"],
    settings: { open: ["#more", "button.more", "[data-action-type=more]"], then: [["#deny", "button.deny", "#save", "button.save"]] }
  },
  {
    // Sourcepoint's window is a frame of its own (cdn.privacy-mgmt.com or the site's subdomain): answered from inside
    // it (FRAME_RULES). On the page itself only its container shows.
    id: "sourcepoint",
    root: "div[id^=sp_message_container_]",
    reject: []
  },
  {
    id: "cookieyes",
    root: ".cky-consent-container:not(.cky-hide), .cky-consent-bar",
    wide: true,
    reject: [".cky-btn-reject", "button[data-cky-tag=reject-button]"],
    settings: { open: [".cky-btn-customize", "button[data-cky-tag=settings-button]"], off: ".cky-preference-center input[type=checkbox]", then: [[".cky-btn-preferences", "button[data-cky-tag=detail-save-button]"]] }
  },
  {
    // CookieYes' older plugin (GDPR Cookie Consent).
    id: "cookieyes",
    root: "#cookie-law-info-bar",
    reject: ["#cookie_action_close_header_reject", "[data-cli_action=reject]", ".cookie_action_close_header_reject"]
  },
  {
    id: "complianz",
    root: ".cmplz-cookiebanner:not(.cmplz-hidden), #cmplz-cookiebanner-container .cmplz-cookiebanner",
    reject: [".cmplz-deny", "button.cmplz-btn.cmplz-deny"],
    settings: { open: [".cmplz-view-preferences", ".cmplz-manage-options"], off: ".cmplz-cookiebanner input[type=checkbox]", then: [[".cmplz-save-preferences"]] }
  },
  {
    id: "iubenda",
    root: "#iubenda-cs-banner",
    // iubenda's ✕ is its «continue without accepting».
    reject: [".iubenda-cs-reject-btn", "button.iubenda-cs-reject-btn", ".iubenda-cs-close-btn"]
  },
  {
    id: "osano",
    root: ".osano-cm-window .osano-cm-dialog:not(.osano-cm-dialog--hidden), .osano-cm-dialog:not(.osano-cm-dialog--hidden)",
    wide: true,
    reject: [".osano-cm-denyAll", ".osano-cm-deny", "button.osano-cm-button--type_denyAll", "button.osano-cm-button--type_deny"],
    settings: { open: [".osano-cm-manage", "button.osano-cm-button--type_manage"], off: ".osano-cm-info input[type=checkbox]", then: [[".osano-cm-save", "button.osano-cm-button--type_save"]] }
  },
  {
    id: "termly",
    root: "[data-tid=banner-decline], [data-tid=banner-accept], #termly-code-snippet-support [role=dialog]",
    wide: true,
    reject: ["button[data-tid=banner-decline]", ".t-declineButton", "button.t-declineButton"]
  },
  {
    id: "klaro",
    root: ".klaro .cookie-notice:not(.cookie-notice-hidden), .klaro .cookie-modal",
    wide: true,
    reject: [".klaro .cn-decline", ".klaro .cm-btn-decline", ".klaro button.cm-btn-danger"],
    settings: { open: [".klaro .cn-learn-more"], off: ".klaro .cookie-modal input[type=checkbox]", then: [[".klaro .cm-btn-decline", ".klaro .cm-btn-accept"]] }
  },
  {
    id: "consentmanager",
    root: "#cmpbox, #cmpwrapper",
    shadow: "#cmpwrapper",
    wide: true,
    reject: ["#cmpwelcomebtnno", ".cmpboxbtnno", "a.cmpboxbtnno", ".cmptxt_btn_no", "#cmpbntnotxt"],
    settings: { open: ["#cmpwelcomebtncustom", ".cmpboxbtncustom"], then: ["reject", [".cmpboxbtnsave", ".cmpboxbtnyescustomchoices", "#cmpbntsavetxt"]] }
  },
  {
    id: "axeptio",
    root: "#axeptio_overlay .axeptio_widget, .axeptio_widget, #axeptio_overlay [class*=axeptio_widget]",
    wide: true,
    reject: ["#axeptio_btn_dismiss", ".axeptio_btn_dismiss", "button[class*=ButtonGroup__BtnStyle][id=axeptio_btn_dismiss]"]
  },
  {
    id: "funding_choices",
    root: ".fc-consent-root .fc-dialog-container, .fc-consent-root .fc-dialog",
    wide: true,
    reject: [".fc-cta-do-not-consent", "button.fc-cta-do-not-consent"],
    settings: { open: [".fc-cta-manage-options"], then: [[".fc-confirm-choices", "button.fc-confirm-choices"]] }
  },
  // Just Eat Takeaway's own (just-eat.co.uk, thuisbezorgd.nl, lieferando.de…): <pie-cookie-banner>, a web component; its
  // buttons are <pie-button> / <pie-link> elements (design-system buttons with shadow roots of their own).
  {
    id: "just_eat",
    root: "pie-cookie-banner",
    shadow: "pie-cookie-banner",
    reject: ["[data-test-id=actions-necessary-only]", "[data-test-id=body-necessary-only]"]
  },
  // Crownpeak's Evidon (TheFork).
  { id: "evidon", root: "#_evidon_banner, #_evidon-message, .evidon-banner", wide: true, reject: ["#_evidon-decline-button", ".evidon-banner-declinebutton"] },
  // Common ones beyond the list: WordPress's Cookie Notice, CookieConsent (Orest Bida; Osano's older one), Borlabs,
  // Shopify's own banner.
  { id: "cookie_notice", root: "#cookie-notice.cookie-notice-visible, #cookie-notice", reject: ["#cn-refuse-cookie", ".cn-refuse-cookie"] },
  { id: "cookieconsent", root: "#cc-main .cm, #cc--main #cm", wide: true, reject: ["#cc-main .cm__btn[data-role=necessary]", "#c-s-bn", "#cc--main .c-bn[data-role=necessary]"] },
  { id: "cookieconsent", root: ".cc-window:not(.cc-invisible)", reject: [".cc-window .cc-deny", ".cc-window .cc-dismiss.cc-deny"] },
  { id: "borlabs", root: "#BorlabsCookieBox ._brlbs-block-content, #BorlabsCookieBox", wide: true, reject: ["#BorlabsCookieBox [data-cookie-refuse]", "#BorlabsCookieBox a._brlbs-refuse-btn", "#BorlabsCookieBox ._brlbs-refuse-btn a"] },
  { id: "shopify", root: ".shopify-pc__banner__dialog, #shopify-pc__banner", wide: true, reject: ["#shopify-pc__banner__btn-decline", ".shopify-pc__banner__btn-decline"] }
]

/** Every rule's window, for one look at whether any platform is on the page at all. */
export const ANY_ROOT = RULES.map((r) => r.root).join(", ")

/**
 * Inside a consent platform's own frame (frameMatch.ts tells which), the whole document is its window: its own
 * buttons first, then a reject label among its buttons; the first layer's settings opened when there's no reject.
 */
export interface FrameRule {
  reject: readonly string[]
  // Its settings from the first layer (Sourcepoint's privacy manager: a frame again, answered there).
  settings?: readonly string[]
  // A settings frame: answered only when we opened it (a person who opened it themselves chooses there).
  ours?: boolean
}

export const FRAME_RULES: Readonly<Record<string, FrameRule>> = {
  sourcepoint_pm: { reject: ["button.sp_choice_type_REJECT_ALL", "button[title='Reject All' i]", "button.sp_choice_type_13"], ours: true },
  // No settings route: on the sites that use it, Sourcepoint's first layer without a reject is a «pay or accept» wall
  // (Spiegel, The Guardian), and its settings lead to the subscription, not to «only necessary».
  sourcepoint: {
    reject: ["button.sp_choice_type_13", "button.sp_choice_type_REJECT_ALL", "button[title='Reject All' i]", "button[title='Reject all' i]"]
  },
  trustarc: { reject: [".rejectAll", "#rejectAll", ".declineAllButtonLower", "a.required", ".required-only"] },
  consentmanager: { reject: [".cmpboxbtnno", "#cmpwelcomebtnno"] }
}
