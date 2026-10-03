/**
 * Klappbare Callouts in selbst gerendertem Markdown bedienbar machen.
 *
 * `MarkdownRenderer.render()` erzeugt `> [!info]-` zwar als eingeklapptes
 * Callout mit Pfeil, haengt aber keinen Klick-Handler an – das tut nur die
 * Leseansicht. Im Chat, im Vergleich und in der Kartenvorschau liess sich so
 * ein Callout deshalb nicht oeffnen (03.10.2026).
 *
 * @param aufklappen alle gleich oeffnen – im Vergleich soll man den Inhalt sehen.
 */
export function klappbareCallouts(el: HTMLElement, aufklappen = false): void {
	el.querySelectorAll<HTMLElement>('.callout.is-collapsible').forEach((callout) => {
		if (aufklappen) setzeZu(callout, false);
		if (callout.dataset.ankiKlappbar) return;
		callout.dataset.ankiKlappbar = '1';
		const titel = callout.querySelector<HTMLElement>(':scope > .callout-title');
		titel?.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			setzeZu(callout, !callout.hasClass('is-collapsed'));
		});
	});
}

function setzeZu(callout: HTMLElement, zu: boolean) {
	callout.toggleClass('is-collapsed', zu);
	const inhalt = callout.querySelector<HTMLElement>(':scope > .callout-content');
	if (inhalt) inhalt.style.display = zu ? 'none' : '';
	callout.querySelector(':scope > .callout-title .callout-fold')?.toggleClass('is-collapsed', zu);
}
