// Which pages of ours are in front, page by page (the director on 03a95321: «Дело на паузе — откройте Safari» came with
// Safari in front). One flag where the last message won was wrong whenever two pages spoke out of order: a tab going
// to its next page (the agent's own «go», a page's script opening its place) has its old page say «hidden» and the new
// one say «visible», and the old page's «hidden» can come last. Safari counts as away only while no page of ours is
// visible. Each page says who it is (a random id per page load), so a tab's old page, unloading late, never hides the
// new one. No imports: tests run it as it is.

export interface PageSeen {
  doc: string
  visible: boolean
}

export class PagesSeen {
  private pages = new Map<number, PageSeen>()

  /** A page of ours (in `tab`, id `doc`) said it's visible or hidden. */
  report(tab: number, doc: string, visible: boolean): void {
    const was = this.pages.get(tab)
    // (A «hidden» from a page that isn't this tab's latest: its old page, unloading after the new one showed.)
    if (!visible && was?.visible && was.doc && doc && was.doc !== doc) return
    this.pages.set(tab, { doc, visible })
  }

  /** The tab closed: its pages say nothing any more. */
  drop(tab: number): void {
    this.pages.delete(tab)
  }

  /** Whether some page of ours is visible, among the tabs still in front of their windows (`active`; all when not given:
   *  a tab that went to a page without us keeps its last word, and a tab behind another isn't seen). */
  anyVisible(active?: Set<number>): boolean {
    for (const [tab, p] of this.pages) if (p.visible && (!active || active.has(tab))) return true
    return false
  }
}
