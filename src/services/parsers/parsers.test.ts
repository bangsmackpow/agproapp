import { describe, expect, it } from 'vitest';

import { parseDocument } from './registry';
import { splitMoneyRow } from './text';

/**
 * Fixtures mirror the real scanned documents, including their quirks: the Channel
 * BOL's unassigned-lot slash runs, Wickman's density values embedded in item
 * descriptions, and an Atticus invoice whose printed total disagrees with its
 * lines (which is exactly why committing is human-reviewed).
 */

const CHANNEL_BOL = [
  'STRAIGHT BILL OF LADING',
  'Received, subject to the classifications and tariffs in effect on the date of this Bill of lading from PRODUCT SUPPLY SEEDS seeds',
  'Page 1 of 1',
  'BOL/CMR Number 8358475862',
  "Shipper's No 8102358163",
  'Order Number 618150791',
  'Customer Purchase Order 618150791',
  'Invoice Date 06/17/2026',
  'Date Printed 06/17/2026',
  'Sold To AG PRO SOLUTIONS LLC 200 E Howard St Des Moines IA 50301-2701',
  'Ship From Creston, IA',
  '1 83169339 C.CL-204-5A5FR1B.SDW.40USP.UT/US /////////// 1.000SP 2,005 LB 2,000 LB',
  '2 91272770 C.CL-211-14SFR1B.SDW.80M.UT/US /////////// 12,000 BAG 607 LB 600 LB',
  '3 05616634 C.CL-284-20A2FR1B.SDH.80M.UT/US /////////// 1.000SP 51 LB 50 LB',
  'Total 24,000 BAG 15,500 LB',
].join('\n');

const ATTCUS_INVOICE = [
  'Atticus',
  'Invoice',
  'Page 1 of 1',
  'Invoice number 500059753',
  'Invoice date 6/18/2026',
  'Payment terms NET 30',
  'Due date 7/18/2026',
  'P.O reference AFS061826',
  'Sales order 500067259',
  'Billing Address Customer Account: 10955',
  'AG PRO SOLUTIONS',
  '1200 E HOWARD ST',
  'CRESTON, IA 50801',
  'Item number Description Quantity Unit Unit price Amount',
  '510042 Felcura 3 E F 2x2.5 GAL Atticus 1800.00 GAL 32.00 57,600.00',
  '510009 Atticus Aquila XL 2x2.5 GAL Atticus 360.00 GAL 35.00 12,600.00',
  'Subtotal',
  'Invoice total (USD) $18,360.00',
  'Payment by Check',
  'ATTICUS LLC',
  'PO BOX 671020',
  'DALLAS, TX 75267',
].join('\n');

const WICKMAN_INVOICE = [
  'Wickman Chemical LLC',
  'P.O. Box 909 Oxford, KS 67119',
  'Invoice # 103935',
  'Date 5/20/2026',
  'DUE 5/20/2026',
  'Bill To',
  'Ag Pro Solutions LLC',
  '1200 E Howard St',
  'Creston, IA 50801',
  'PO # PD 056840011 IA',
  'Sales Rep NK',
  'Item Code Description Quantity Price Each Amount',
  'Atrazine 4L - 2x2.5 (R) Atrazine 4L - 2x2.5 Gal. Liquid, EPA# 35915-4-60663 Not DOT Regulated. Density 8.35 Can Not Sell in AK, CA, HI. 55 14.77 812.35',
  'Clarity - 2x2.5 En (R) Engame DGA - 2x2.5 Gal. Liquid, EPA# 83529-53-94278 Not DOT Regulated, Dicamba Diglycolamine Salt. Density 9.69 Can Sell in AL, AR, IL, IN, IA, KS, LA, MS, NE, NM, OK, TX. 22.5 29.40 661.50',
  'Mesotrione 4SC - (R) Mesotrione 4SC - 2x2.5 Gal. Liquid, EPA# 84224-48 Not DOT Regulated, Tide. Density 9.9 10 43.24 432.40',
  '2,4-D LV6 - 2x2.5 (R) 2,4-D LV6 - 2x2.5 Gal. Liquid, EPA# 81927-39. Not DOT Regulated. Alligare. Density 9.28 35 27.73 970.55',
  'Page 1 of 1',
  'Broker/Generic Products: No Returns, No Rebates, No Agronomy Support',
].join('\n');

const IB_INVOICE = [
  'I & B AG SUPPLY',
  'IB Enterprises, LLC DBA',
  'Sales Order #SO8488',
  'TOTAL $2,528.14',
  'Terms Cash upfront',
  'Ship Date 06/15/2026',
  'Item EPA # Rate Units Package Size # of Containers Amount',
  'Super Gun Agrocete - 1s $0.00 Gal 1 8 $0.00',
  'DAT TECH Agrocete - 36 oz $34.632 Oz 3662 bottle 73 $2,528.14',
  'Subtotal $2,528.14',
  'Tax Total (%) $0.00',
  'Total $2,528.14',
].join('\n');

describe('parser detection', () => {
  it('routes each document to the right vendor parser', () => {
    expect(parseDocument(CHANNEL_BOL).parserKey).toBe('channel_bol_v1');
    expect(parseDocument(ATTCUS_INVOICE).parserKey).toBe('atticus_invoice_v1');
    expect(parseDocument(WICKMAN_INVOICE).parserKey).toBe('wickman_invoice_v1');
    expect(parseDocument(IB_INVOICE).parserKey).toBe('ib_ag_supply_order_v1');
  });

  it('refuses a document it cannot interpret rather than guessing', () => {
    expect(() => parseDocument('hello world, an unrelated memo')).toThrow(/No parser recognised/i);
  });

  it('honours an explicitly forced parser', () => {
    const parsed = parseDocument(IB_INVOICE, { parserKey: 'wickman_invoice_v1' });
    expect(parsed.parserKey).toBe('wickman_invoice_v1');
  });
});

describe('Channel straight bill of lading', () => {
  const parsed = parseDocument(CHANNEL_BOL);

  it('isolates both Iowa audit tokens', () => {
    expect(parsed.header.bolCmrNumber).toBe('8358475862');
    expect(parsed.header.orderNumber).toBe('618150791');
  });

  it('captures the shipper number, seed number and PO', () => {
    expect(parsed.header.shipperNumber).toBe('8102358163');
    expect(parsed.header.shipperNumber).not.toBe(parsed.header.orderNumber);
    expect(parsed.header.poNumber).toBe('618150791');
  });

  it('captures the invoice date', () => {
    expect(parsed.header.documentDate).toBe('06/17/2026');
  });

  it('extracts the line items with material codes and quantities', () => {
    expect(parsed.lineItems).toHaveLength(3);

    const [first] = parsed.lineItems;
    expect(first?.lineNumber).toBe(1);
    expect(first?.itemCode).toBe('83169339');
    expect(first?.quantity).toBe(1);
    expect(first?.unit).toBe('SP');
    expect(first?.description).toBe('C.CL-204-5A5FR1B.SDW.40USP.UT/US');

    const [, second] = parsed.lineItems;
    expect(second?.quantity).toBe(12000);
    expect(second?.unit).toBe('BAG');
  });

  it('raises no warnings when both audit tokens are present', () => {
    expect(parsed.warnings).toEqual([]);
  });

  it('warns when an audit token is missing, and does not reach across lines for one', () => {
    const damaged = CHANNEL_BOL.replace('BOL/CMR Number 8358475862', 'BOL/CMR Number');
    const result = parseDocument(damaged);

    expect(result.header.bolCmrNumber).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('BOL/CMR'))).toBe(true);
  });
});

describe('Atticus invoice', () => {
  const parsed = parseDocument(ATTCUS_INVOICE);

  it('captures header fields', () => {
    expect(parsed.header.documentNumber).toBe('500059753');
    expect(parsed.header.documentDate).toBe('6/18/2026');
    expect(parsed.header.dueDate).toBe('7/18/2026');
    expect(parsed.header.termsDays).toBe(30);
    expect(parsed.header.poNumber).toBe('AFS061826');
  });

  it('extracts priced line items', () => {
    expect(parsed.lineItems).toHaveLength(2);

    const [first] = parsed.lineItems;
    expect(first?.description).toBe('510042 Felcura 3 E F 2x2.5 GAL Atticus');
    expect(first?.quantity).toBe(1800);
    expect(first?.unitCostCents).toBe(3200);
    expect(first?.amountCents).toBe(5_760_000);

    const [, second] = parsed.lineItems;
    expect(second?.amountCents).toBe(1_260_000);
  });

  it('reads the printed invoice total verbatim, even when it disagrees with the lines', () => {
    // The scanned document prints $18,360.00 against lines totalling $70,200.00.
    // Extracting what is printed (and flagging it for review) is the correct
    // behaviour: silently "fixing" a vendor's arithmetic would be worse.
    expect(parsed.header.totalCents).toBe(1_836_000);
  });
});

describe('Wickman Chemical invoice', () => {
  const parsed = parseDocument(WICKMAN_INVOICE);

  it('captures header fields', () => {
    expect(parsed.header.documentNumber).toBe('103935');
    expect(parsed.header.documentDate).toBe('5/20/2026');
    expect(parsed.header.poNumber).toBe('PD');
  });

  it('extracts line items with quantity, unit price and amount', () => {
    expect(parsed.lineItems).toHaveLength(4);

    const [first] = parsed.lineItems;
    expect(first?.quantity).toBe(55);
    expect(first?.unitCostCents).toBe(1477);
    expect(first?.amountCents).toBe(81_235);
    expect(first?.epaNumber).toBe('35915-4-60663');
  });

  it('keeps a description that contains a density value intact', () => {
    // "Density 8.35" must not be mistaken for a price column and truncate the row.
    const [first] = parsed.lineItems;
    expect(first?.description).toContain('Atrazine 4L');
    expect(first?.description).toContain('Can Not Sell in AK, CA, HI.');
  });

  it('lifts the EPA number out of the description', () => {
    const epaNumbers = parsed.lineItems.map((item) => item.epaNumber);
    expect(epaNumbers).toEqual([
      '35915-4-60663',
      '83529-53-94278',
      '84224-48',
      '81927-39',
    ]);
  });

  it('does not invent line items from party or footer text', () => {
    const descriptions = parsed.lineItems.map((item) => item.description.toLowerCase());
    expect(descriptions.some((text) => text.includes('broker/generic'))).toBe(false);
    expect(descriptions.some((text) => text.includes('page 1 of 1'))).toBe(false);
  });
});

describe('I & B Ag Supply order', () => {
  const parsed = parseDocument(IB_INVOICE);

  it('captures the sales order number and totals', () => {
    expect(parsed.header.documentNumber).toBe('SO8488');
    expect(parsed.header.totalCents).toBe(252_814);
    expect(parsed.header.documentDate).toBe('06/15/2026');
  });

  it('extracts line items', () => {
    expect(parsed.lineItems).toHaveLength(2);
    expect(parsed.lineItems[1]?.amountCents).toBe(252_814);
    expect(parsed.lineItems[1]?.unitCostCents).toBe(3463);
  });
});

describe('splitMoneyRow', () => {
  it('returns undefined for a line with no money columns', () => {
    expect(splitMoneyRow('AG PRO SOLUTIONS')).toBeUndefined();
  });

  it('treats the last token as the amount and the previous as the unit price', () => {
    const row = splitMoneyRow('Mesotrione 4SC 10 43.24 432.40');
    expect(row?.amountCents).toBe(43_240);
    expect(row?.unitCostCents).toBe(4324);
    expect(row?.quantity).toBe(10);
    expect(row?.description).toBe('Mesotrione 4SC');
  });
});
