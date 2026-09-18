# Synthetic fixtures

`simple-pre-extracted.json` is handwritten structured input for unit tests, not an invoice extracted by AI.
The currency and amounts are arbitrary demo values. No jurisdiction or valid tax rate is implied.

`../output/pdf/synthetic-bookkeeping-invoice.pdf` is the original one-page text PDF for the
vertical-slice test. `synthetic-invoice-answer-key.json` records its exact SHA-256 and expected
printed values. `scripts/check-synthetic-answer-key.py` independently checks the hash and money
with Python Decimal. `synthetic-recorded-model-response.json` is a local adapter fixture, not a
live AI result; it exists so the complete local workflow can run without credentials or network.

One synthetic document is not an extraction benchmark. A live model result is recorded separately
only after the PDF is retrieved from the authorized Telnyx inbox and the configured model is found
in that account's live `/v2/ai/openai/models` response.
