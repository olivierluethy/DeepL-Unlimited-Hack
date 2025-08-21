# First Version Prompt

Zuerst habe ich mir die Webseite selbst angeschaut. Ich habe mir dabei die jeweiligen Elemente unter betracht genommen und geschaut, wie ich auf sie genau zugreifen kann.

```javascript
// So viele Zeichen wurden vom Benutzer eingegeben
const factualWords = document.querySelector(
  "[data-testid='write-character-counter']"
).children[0].innerHTML;

// Die maximale Zeichen wo man eingeben kann (limitiert auf 2000 Zeichen)
const maxWords = document.querySelector(
  "[data-testid='write-character-counter']"
).children[2].innerHTML;

// Woher der Text kommt für die Konvertierung
const transSource = document.querySelector(
  "[data-testid='translator-source-input']"
);

// Woher der Text kommt für die konvertierte Version vom Text
const transResult = document.querySelector(
  "[data-testid='translator-target-input']"
);

// So kann dann jeweils auf deren Eingabe zugegriffen werden
flag = transSource.querySelector("[role='textbox']").children[0].textContent;
flag = transResult.querySelector("[role='textbox']").children[0].textContent;
```

Bitte erstelle mir eine Chrome Browser Erweiterung die sich auf deepl.com konzentriert.

Man soll in der Erweiterung selbst ein Textfeld haben wo man einen Text eingeben kann. Wenn man dann auf senden klickt, dann soll er diesen Text zu diesem Element schicken:
const transSource = document.querySelector("[data-testid='translator-source-input']");
sourceText = transSource.querySelector("[role='textbox']").children[0].textContent;

Dieses Element ist für die Entgegennahme von eingaben dafür zuständig. Die Ausgabe erfolgt in diesem Element:
const transResult = document.querySelector("[data-testid='translator-target-input']");
convertedText = transResult.querySelector("[role='textbox']").children[0].textContent;

Wichtig ist, dass es auf der Webseite pro Eingabe limiten gibt. Z.B. darf man maximal 2000 Zeichen inklusive Lehrschlag haben sonst muss man auf der Webseite für grössere Bearbeitung der Texte bezahlen.

Um die Anzahl an Zeichen zu bekommen kannst du auf dieses Element zugreifen: const factualWords = document.querySelector("[data-testid='write-character-counter']").children[0].innerHTML;

Und nur für den Fall sollte sich die Maximale Anzahl mal verändern, kannst du auf dieses Element dich verlassen:
const maxWords = document.querySelector("[data-testid='write-character-counter']").children[2].innerHTML;

Bedenke, dass man pro Textbearbeitung der Webseite zirka 2 Sekunden gebunden muss damit der convertierte Text sich ergibt.

Das Ziel hinter der ganzen Sache ist, dass man auf der Erweiterung einen egal wie grossen Text eingeben kann, dann auf Senden klickt, und wenn man sich auf deepl.com befindet, soll er diesen Text, wenn mein Text z.B. 4000 Zeichen beinhaltet, sodass er ihn korrekt aufteilt sodass er z.B. 2\*2000 macht, oder wenn mein Text 16000 Zeichen hat, er dann selbstständig rechnet wie er den Text aufteilen muss damit sich am Schluss alles sauber convertieren lässt.

Am Ende soll es alle convertierte Texte zusammentragen und auf der Erweiterungsübersicht mit Zeitpunkt der Fertigstellung in verschiedenste Formate wie Word, Txt oder PDF herunterladbar sein.
