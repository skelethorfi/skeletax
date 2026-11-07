// An amount in an asset's base units, exact (docs/specs/activity.md). No floats: it is formatted only when
// a row is written.
export interface Amount {
  base: bigint;
  decimals: number;
}

// A source's base-unit string, e.g. Midgard's '2000000' with 8 decimals is 0.02
export function parseAmount(base: string, decimals: number): Amount {
  if (!/^-?\d+$/.test(base)) {
    throw new Error(`Invalid base amount: ${base}`);
  }

  return { base: BigInt(base), decimals };
}

// The decimal string, without trailing zeros: 0.02, 1, 5000
export function formatAmount({ base, decimals }: Amount): string {
  const sign = base < 0n ? "-" : "";
  const digits = (base < 0n ? -base : base).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");

  return sign + whole + (fraction ? `.${fraction}` : "");
}

// A decimal string, e.g. formatAmount's '0.02', back to an exact amount with as many decimals as it has
export function parseDecimal(text: string): Amount {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);

  if (!match) {
    throw new Error(`Invalid decimal amount: ${text}`);
  }

  const [, sign, whole, fraction = ""] = match;
  return { base: BigInt(sign + whole + fraction), decimals: fraction.length };
}
