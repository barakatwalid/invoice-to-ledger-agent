"""Independent oracle: standard-library Decimal, not the JS implementation.
Regenerate intentionally; changes to labels require review. No external services.
"""
import json
import random
from decimal import Decimal, ROUND_HALF_UP, localcontext
from pathlib import Path
SEED = 0x5EED1234
rng = random.Random(SEED)
cases = []
with localcontext() as context:
    context.prec = 60
    for i in range(1000):
        quantity = Decimal(rng.randrange(-2_000_000, 2_000_001)) / 1000
        price = Decimal(rng.randrange(-200_000_000, 200_000_001)) / 1_000_000
        scale = rng.choice([0, 2, 3])
        result = (quantity * price).quantize(Decimal(1).scaleb(-scale), rounding=ROUND_HALF_UP)
        # The core normalizes negative zero; the oracle does so explicitly too.
        if result == 0:
            result = abs(result)
        cases.append({'id': i+1, 'quantity': format(quantity, 'f'), 'unitPrice': format(price, 'f'),
                      'minorUnits': scale, 'expected': format(result, f'.{scale}f')})
output = Path(__file__).resolve().parents[1] / 'fixtures' / 'arithmetic-oracle.json'
output.write_text(json.dumps({'seed': hex(SEED), 'oracle': 'Python decimal; precision=60; ROUND_HALF_UP',
                              'caseCount': len(cases), 'cases': cases}, indent=2) + '\n')
print(f'Wrote {len(cases)} oracle cases to {output.name}')
