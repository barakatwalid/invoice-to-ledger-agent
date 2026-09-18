import hashlib
import json
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path


PDF = Path("output/pdf/synthetic-bookkeeping-invoice.pdf")
ANSWER = Path("fixtures/synthetic-invoice-answer-key.json")


def main() -> None:
    answer = json.loads(ANSWER.read_text(encoding="utf-8"))
    digest = hashlib.sha256(PDF.read_bytes()).hexdigest()
    assert digest == answer["pdfSha256"], "PDF hash does not match the separately stored answer key"
    expected = answer["expected"]
    line_total = Decimal("0")
    for line in expected["lines"]:
        calculated = (Decimal(line["quantity"]) * Decimal(line["unitPrice"])).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
        assert calculated == Decimal(line["lineNet"]), "line extension mismatch"
        line_total += calculated
    assert line_total == Decimal(expected["subtotal"]), "subtotal mismatch"
    assert Decimal(expected["subtotal"]) + Decimal(expected["tax"]) == Decimal(expected["total"]), "total mismatch"
    print(json.dumps({
        "status": "PASS",
        "oracle": "Python Decimal ROUND_HALF_UP",
        "pdfSha256": digest,
        "linesChecked": len(expected["lines"]),
    }, indent=2))


if __name__ == "__main__":
    main()
