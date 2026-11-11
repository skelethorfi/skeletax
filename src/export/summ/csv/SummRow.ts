import { SummRowType } from "./SummRowType.ts";

export interface SummRow {
  /**
   * Wallet
   * (Not a Summ column)
   *
   * The wallet address the row belongs to: rows are written to one CSV per wallet, which is
   * imported into that wallet's account in Summ. Part of the row ID.
   */
  wallet?: string;

  // NOTE: default was previously DD/MM/YYYY HH:mm:ss
  /**
   * Timestamp (UTC)
   *
   * Written as ISO 8601 UTC (e.g. 2025-07-01T12:00:00.000Z) when the CSV is rendered.
   * The default format is set as YYYY-MM-DD HH:mm:ss.
   * However, you can also select different time formats by clicking on 'Advanced Options' when importing.
   * (Check [here](https://help.cryptotaxcalculator.io/en/articles/5777675-advanced-custom-csv-import#h_e0d1330f6e) for more details.)
   */
  timestamp: Date;

  /**
   * Type
   * This is the type of transaction, e.g., buy, sell. You can read more about the valid transaction types below.
   */
  type: SummRowType;

  /**
   * Base Currency
   * The base currency of the trading pair. For example, if you purchase ETH using USD, the base currency is ETH.
   */
  baseCurrency: string;

  /**
   * Base Amount
   * The amount excluding fee which corresponds to the base currency.
   */
  baseAmount: string;

  /**
   * Quote Currency
   * The quote currency of the trading pair. For example, if you purchase ETH using USD, the quote currency is USD.
   */
  quoteCurrency?: string;

  /**
   * Quote Amount
   * The amount of quote currency that was traded, excluding fees.
   */
  quoteAmount?: string;

  /**
   * Fee Currency (Optional)
   * The currency in which the fee was paid.
   */
  feeCurrency?: string;

  /**
   * Fee Amount (Optional)
   * The amount of fees that were paid.
   */
  feeAmount?: string;

  /**
   * From (Optional)
   *
   * The name of the exchange/wallet you are transferring from.
   * If left blank, it will default to the exchange/wallet name where you import the CSV.
   *
   * Note: If manually importing for multiple exchanges/wallets, please ensure you have a CSV for each source rather
   * than compiling everything into one file to avoid in-app source & destination confusion.
   */
  from?: string;

  /**
   * To (Optional)
   *
   * The name of the exchange/wallet you are transferring to.
   * If left blank, it will default to the exchange/wallet name where you import the CSV.
   *
   * Note: If manually importing for multiple exchanges/wallets, please ensure you have a CSV for each source rather
   * than compiling everything into one file to avoid in-app source & destination confusion.
   */
  to?: string;

  /**
   * Blockchain (Optional)
   *
   * The blockchain where the transaction happened.
   * This is particularly important for interacting with wallets that are imported on multiple chains.
   *
   * Note: Only the blockchains we support are valid. If an invalid blockchain is entered, this field will be ignored in the app.
   */
  blockchain?: string;

  /**
   * ID (Optional)
   *
   * Any transaction ID that you would like to associate with this transaction for easy searching on the review transactions page.
   * It should be unique where possible.
   */
  id?: string;

  /**
   * Description (Optional)
   * Note: No longer listed on the Advanced CSV page. But still included in the CSV template and still seems to be supported.
   */
  description?: string;

  // Not a CSV column: what the row's ID is made from (docs/specs/periods.md, Row IDs). A mapper sets the role
  // (and the leg's asset when one action has several rows of a role); exportSumm adds the record.
  trace?: RowTrace;

  /**
   * Reference Price Per Unit (Optional)
   * The price per unit of the 'Base Currency'. If left blank, the price defaults to market price.
   */
  referencePricePerUnit?: string;

  /**
   * Reference Price Currency (Optional)
   *
   * This is the currency of the Reference Price Per Unit.
   *
   * - Only fiat currencies are valid. Cryptocurrencies (including stablecoins) in this column will be ignored.
   * - Only use this when Reference Price Per Unit is filled.
   * - If left blank but with Reference Price Per Unit filled, this defaults to USD.
   */
  referencePriceCurrency?: "AUD" | "USD";
}

export interface RowTrace {
  // The store record of the action, e.g. 'midgard/swap.<txid>'; a FIN swap's without its fill hash (the activity id)
  record?: string;
  // What the row is in the action, e.g. 'trade-out', 'add', 'price-helper'
  role: string;
  // The leg's asset as the source names it, e.g. 'BTC.BTC', when the action has a row of this role per asset
  asset?: string;
  // A sell's or buy's quote asset as the source names it, e.g. 'ETH~ETH': for the balance check, never in the row ID
  quoteAsset?: string;
}
