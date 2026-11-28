/* Entities / Whale Watch seed — the public addresses behind the ENTITIES tab.

   Every address here is confirmed twice: a public source names it (a government, the
   exchange itself, a court record, the chain itself, or a named analytics attribution)
   and mempool.space's address API was read for its balance. Nothing is guessed; an
   address whose public listing could not be found is left out, and the entity's `extra`
   field says so. Verification run 2026-11-28 04:56 UTC at block 977,898.

   Shape:  { v, at, block, price, priceAt, tracked, list: [entity] }
           entity  = { id, name, category, icon, badge, evidence, live, description,
                       extra, est, addresses: [address], total }
           address = { address, label, sats, p2pkSats?, source, note, live }

   `category` is PERSON | CORP | GOV | OTHER (the five filter chips add ALL). `icon` picks
   the line icon (person, corp, gov, group, hacker), so a hacker card keeps its mask while
   sitting in OTHER. `evidence` is official (the party published it) | chain (the chain
   settles it) | attributed (an analytics label, not proof of ownership). `sats` is the
   balance the verification read and `total` is the sum of the addresses actually listed —
   never an entity's whole holding, which every card says in words.

   The block-1 Satoshi address is the one adjusted figure: its 50 BTC P2PK coinbase is
   still unspent but is not in the address statistics, so `sats` carries the corrected
   51.35275617 BTC and the note explains it. `total` is always the sum of the verified
   addresses listed, and never an estimate. An entity may also carry `est`: an estimate a
   named source publishes (the Patoshi pattern, ~1.1M BTC over some 20,000 addresses, is
   the only one). The card adds it to the entity's held total and prints the verified part
   beside it, so the sum never hides which half came from the chain and which from an
   estimate.

   build.py inlines this file and also writes dist/entities.json, the same payload the app
   tries to refresh from https://corejbh.github.io/nodepulse/entities.json. `v` is the
   payload version: v2 added `est`, and a table saved under v1 is replaced by it rather
   than kept, so a page that adopted the older file picks up the estimate. */
var ENTITIES = {
  "v": 2,
  "at": "2026-11-28T04:56:00Z",
  "block": 977898,
  "price": 59700,
  "priceAt": "2026-11-28T05:10:00Z",
  "tracked": 101365115607770,
  "list": [
    {
      "id": "satoshi",
      "name": "Satoshi Nakamoto",
      "category": "PERSON",
      "icon": "person",
      "badge": "Patoshi Pattern",
      "evidence": "chain",
      "live": true,
      "description": "Bitcoin's creator. The genesis coinbase and the first blocks are fixed in the chain, so the addresses below are facts rather than attributions.",
      "extra": "Patoshi Pattern: about 22,000 blocks (~1.1M BTC; Whale Alert 2020 estimated 1,122,693 BTC over 22,503 blocks) are spread across some 20,000 coinbase addresses. They are deliberately not swept: 20,000 lookups would only earn a rate limit. The badge marks the estimate, the held total adds it, and the verified part is printed beside it.",
      "est": {
        "label": "Patoshi Est.",
        "sats": 110000000000000,
        "note": "~1,100,000 BTC: the rounded figure for the Patoshi pattern (Whale Alert 2020 counted 1,122,693 BTC over 22,503 blocks). An estimate from a named source, not a read balance."
      },
      "addresses": [
        {
          "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
          "label": "Genesis block (block 0) coinbase",
          "sats": 5772160695,
          "source": "mempool.space /api/address",
          "note": "The 50 BTC of the genesis coinbase are unspendable by protocol and are not counted in address statistics. The balance shown is later donations only.",
          "live": true
        },
        {
          "address": "12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX",
          "label": "Block 1 coinbase (first block mined after genesis)",
          "sats": 5135275617,
          "p2pkSats": 5000000000,
          "source": "mempool.space /api/address",
          "note": "The address API reports 1.35275617 BTC received later, but the 50 BTC P2PK coinbase output of tx 0e3e2357... is still unspent, so the tracked balance is adjusted to 51.35275617 BTC. p2pkSats carries the 50 BTC the API leaves out, and a live read adds it back. This address is block 1, not block 9 (a common web error).",
          "live": true
        },
        {
          "address": "12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S",
          "label": "Block 9 coinbase (input of the first P2P transfer in block 170)",
          "sats": 44412447,
          "source": "mempool.space /api/address",
          "note": "The original 50 BTC was spent as the input of the first person-to-person transfer (10 BTC to Hal Finney, block 170). The remainder is later donations.",
          "live": true
        }
      ],
      "total": 10951848759
    },
    {
      "id": "hal-finney",
      "name": "Hal Finney",
      "category": "PERSON",
      "icon": "person",
      "badge": "Historic",
      "evidence": "chain",
      "live": false,
      "description": "Recipient of the first person-to-person bitcoin transfer (block 170, 2009-01-12).",
      "extra": null,
      "addresses": [
        {
          "address": "1Q2TWHE3GMdB6BZKafqwxXtWAWgFt5Jvm3",
          "label": "First P2P receive (10 BTC, block 170)",
          "sats": 0,
          "source": "mempool.space /api/address",
          "note": "The 10 BTC was paid to a P2PK output that address statistics do not count, and it moved in block 92,240. Balance is 0 (the 0.0446 BTC of later donations was spent too). Kept as a historic marker.",
          "live": false
        }
      ],
      "total": 0
    },
    {
      "id": "laszlo-hanyecz",
      "name": "Laszlo Hanyecz (Pizza Day)",
      "category": "PERSON",
      "icon": "person",
      "badge": "Pizza Day 2010",
      "evidence": "chain",
      "live": true,
      "description": "On 2010-05-22 Laszlo Hanyecz paid 10,000 BTC for two pizzas. Both sides of that transaction are listed.",
      "extra": "The chain record is settled (tx a1075db5..., block 57,043). Ownership attribution rests on Hanyecz naming the address himself on the forum and on press coverage.",
      "addresses": [
        {
          "address": "1XPTgDRhN8RFnzniWCddobD9iKZatrvH4",
          "label": "Laszlo Hanyecz (sender, self-attributed)",
          "sats": 3234782,
          "source": "bitcoin.com explorer / tx a1075db5...",
          "note": "All 131 inputs of the pizza transaction came from this address. The balance shown is later small deposits.",
          "live": true
        },
        {
          "address": "17SkEw2md5avVNyYgj6RiXuQKNwkXaxFyQ",
          "label": "jercos (recipient, 10,000 BTC)",
          "sats": 2473041,
          "source": "mempool.space /api/address",
          "note": "The 10,000 BTC was split and moved ten minutes later. The balance shown is later small deposits.",
          "live": true
        }
      ],
      "total": 5707823
    },
    {
      "id": "tim-draper",
      "name": "Tim Draper",
      "category": "PERSON",
      "icon": "person",
      "badge": "Auction 2014",
      "evidence": "attributed",
      "live": false,
      "description": "Venture investor who won the 2014 U.S. Marshals auction of 29,656 BTC seized from Silk Road.",
      "extra": "The address below is the one the auction payout was sent to (1Ez69... to 1a8LDh...), which the press reported at the time and which Draper's auction win confirms. Draper publicly disputed a later Arkham attribution of a different wallet in 2026, so only this chain-documented payout address is listed, and it is a historic marker now: 0.00006558 BTC of dust remains.",
      "addresses": [
        {
          "address": "1a8LDh3qtCdMFAgRXzMrdvB8w1EG4h1Xi",
          "label": "2014 USMS auction payout (29,656 BTC)",
          "sats": 6558,
          "source": "https://cointelegraph.com/news/feds-sell-29656-bitcoins-to-single-bidder-in-silk-road-auction",
          "note": "Received 29,656.51933514 BTC on 2014-07-01 and spent over the following years. Not a claim about any wallet Draper holds today.",
          "live": false
        }
      ],
      "total": 6558
    },
    {
      "id": "us-government",
      "name": "U.S. Government",
      "category": "GOV",
      "icon": "gov",
      "badge": null,
      "evidence": "attributed",
      "live": true,
      "description": "Bitcoin seized by the U.S. Department of Justice and the FBI. The Silk Road (Individual X, 2020) and Bitfinex (2022) seizures are the largest.",
      "extra": "Arkham attributes 623 addresses and 306,795 BTC to the entity (2026-11). The James Zhong seizure (51,326 BTC over 4 wallets) and the Prince Group seizure (127,271 BTC) have no publicly confirmed individual addresses, so they are not listed.",
      "addresses": [
        {
          "address": "bc1qa5wkgaew2dkv56kfvj49j0av5nml45x9ek9hz6",
          "label": "Silk Road seizure (Individual X, 2020)",
          "sats": 6937018476959,
          "source": "https://arkm.com/announcements/the-us-government-is-now-an-entity-on-arkham",
          "note": "Seized 2020-11; unspent as of 2026-11.",
          "live": true
        },
        {
          "address": "bc1qazcm763858nkj2dj986etajv6wquslv8uxwczt",
          "label": "Bitfinex hack seizure (2022)",
          "sats": 9464348826145,
          "source": "https://arkm.com/announcements/the-us-government-is-now-an-entity-on-arkham",
          "note": "Seized 2022-02; unspent as of 2026-11.",
          "live": true
        }
      ],
      "total": 16401367303104
    },
    {
      "id": "el-salvador",
      "name": "El Salvador",
      "category": "GOV",
      "icon": "gov",
      "badge": null,
      "evidence": "official",
      "live": true,
      "description": "The first country to make bitcoin legal tender. The National Bitcoin Office (ONBTC) publishes the reserve addresses.",
      "extra": "About 7,814 to 7,846 BTC across 20 published addresses (2026-10). A single address was split into 14 of at most 500 BTC each on 2025-08-29, and 500 BTC addresses have been added since. Five representative addresses are listed.",
      "addresses": [
        {
          "address": "32ixEdVJWo3kmvJGMTZq5jAQVZZeuwnqzo",
          "label": "2024-03 first published address (retired)",
          "sats": 0,
          "source": "https://bitcoin.gob.sv/address/32ixEdVJWo3kmvJGMTZq5jAQVZZeuwnqzo",
          "note": "The address the president published on 2024-03-15. Balance 0 since the 2025-08-29 split; kept as a historic marker.",
          "live": false
        },
        {
          "address": "3Fh6QjPzfu2LWYxVYqRZ45QPTja1PrFmNC",
          "label": "ONBTC reserve (split address)",
          "sats": 50000000546,
          "source": "https://bitcoin.gob.sv/address/3Fh6QjPzfu2LWYxVYqRZ45QPTja1PrFmNC",
          "note": null,
          "live": true
        },
        {
          "address": "359jBt2XuTdgk6YEz1WwhwMwrzTd7Qb3Gw",
          "label": "ONBTC reserve (moved 2026-05-23)",
          "sats": 50000100000,
          "source": "https://bitcoin.gob.sv/address/359jBt2XuTdgk6YEz1WwhwMwrzTd7Qb3Gw",
          "note": null,
          "live": true
        },
        {
          "address": "3DrHiHzfAKnne3zn8pqJdxJQhRFtW1jnMG",
          "label": "ONBTC reserve (split address)",
          "sats": 50000001622,
          "source": "https://bitcoin.gob.sv/address/3DrHiHzfAKnne3zn8pqJdxJQhRFtW1jnMG",
          "note": null,
          "live": true
        },
        {
          "address": "3KXKHH5hhiYkx9nfJdUxZL3ivrVSnQNfKz",
          "label": "ONBTC reserve (1 BTC/day purchases)",
          "sats": 25768903075,
          "source": "https://bitcoin.gob.sv/address/3KXKHH5hhiYkx9nfJdUxZL3ivrVSnQNfKz",
          "note": "255 small purchases accumulated here.",
          "live": true
        }
      ],
      "total": 175769005243
    },
    {
      "id": "bhutan",
      "name": "Bhutan (Druk Holding & Investments)",
      "category": "GOV",
      "icon": "gov",
      "badge": null,
      "evidence": "attributed",
      "live": true,
      "description": "The sovereign fund DHI mines bitcoin with surplus hydropower. The government has never published a balance; only the Arkham attribution exists.",
      "extra": "Arkham attributes 274 addresses and 525.097 BTC (2026-11-28). Mining payouts are spread over many small addresses, so one representative address is listed.",
      "addresses": [
        {
          "address": "bc1q22q82m27mx5dsyasfrtrwgqm4ly3lnevlyzmvhxf33ehkd7uhklsw5ga9j",
          "label": "DHI: BitGo Custody",
          "sats": 14626655330,
          "source": "https://arkm.com/explorer/address/bc1q22q82m27mx5dsyasfrtrwgqm4ly3lnevlyzmvhxf33ehkd7uhklsw5ga9j",
          "note": "Unmoved since 2025-11-18. Arkham label.",
          "live": true
        },
        {
          "address": "3QkQz739oPCen7HfNQzaNyV6DwDx4JB7iS",
          "label": "DHI main wallet (source of the 2026-03 outflow)",
          "sats": 0,
          "source": "https://btc.network/blog/bhutan-120m-bitcoin-sell-off-2026-on-chain-analysis",
          "note": "Moved all 319.71 BTC in 2026-03; balance 0. Historic reference.",
          "live": false
        }
      ],
      "total": 14626655330
    },
    {
      "id": "uk-government",
      "name": "U.K. Government",
      "category": "GOV",
      "icon": "gov",
      "badge": null,
      "evidence": "attributed",
      "live": true,
      "description": "61,000 BTC seized by London police in 2018 from the Jian Wen and Zhimin Qian fraud. The U.K. government has never published addresses; the Arkham labels are the only public basis.",
      "extra": "Arkham attributes 4 addresses and 61,245 BTC. The three below total 53,744.82 BTC; the fourth has no public page and is not listed.",
      "addresses": [
        {
          "address": "bc1q7ydrtdn8z62xhslqyqtyt38mm4e2c4h3mxjkug",
          "label": "Zhimin Qian & Jian Wen fraud funds",
          "sats": 3600042412913,
          "source": "https://arkm.com/explorer/address/bc1q7ydrtdn8z62xhslqyqtyt38mm4e2c4h3mxjkug",
          "note": null,
          "live": true
        },
        {
          "address": "bc1q4vxn43l44h30nkluqfxd9eckf45vr2awz38lwa",
          "label": "Zhimin Qian & Jian Wen fraud funds",
          "sats": 1300302310461,
          "source": "https://arkm.com/explorer/address/bc1q4vxn43l44h30nkluqfxd9eckf45vr2awz38lwa",
          "note": null,
          "live": true
        },
        {
          "address": "bc1qncsa0qdrgsr58303gsnuwhd5vrm7hlkpd6klmf",
          "label": "Zhimin Qian & Jian Wen fraud funds",
          "sats": 474136841988,
          "source": "https://arkm.com/explorer/address/bc1qncsa0qdrgsr58303gsnuwhd5vrm7hlkpd6klmf",
          "note": null,
          "live": true
        }
      ],
      "total": 5374481565362
    },
    {
      "id": "germany",
      "name": "Germany (BKA)",
      "category": "GOV",
      "icon": "gov",
      "badge": "Sold 2024",
      "evidence": "attributed",
      "live": false,
      "description": "About 50,000 BTC seized from the Movie2k.to operators by the Saxony state police and held by the BKA, then sold in full in June and July 2024.",
      "extra": "The government never confirmed addresses; Arkham attributed five by size and timing, and heise reported them. What remains is 0.0005389 BTC of dust, so this is a historic card.",
      "addresses": [
        {
          "address": "bc1qgrvchamnmmaancn3vwea6elnvexpylzh30rhjz",
          "label": "BKA Movie2k.to funds",
          "sats": 16628,
          "source": "https://www.heise.de/en/news/Movie2k-bitcoins-worth-billions-much-ado-about-little-9777779.html",
          "note": null,
          "live": false
        },
        {
          "address": "bc1q0unygz3ddt8x0v33s6ztxkrnw0s0tl7zk4yxwd",
          "label": "BKA Movie2k.to funds",
          "sats": 0,
          "source": "https://www.heise.de/en/news/Movie2k-bitcoins-worth-billions-much-ado-about-little-9777779.html",
          "note": null,
          "live": false
        },
        {
          "address": "bc1q93njc4we4s088a2nz6c9e6vthc5h4ake53rxmd",
          "label": "BKA Movie2k.to funds",
          "sats": 15968,
          "source": "https://www.heise.de/en/news/Movie2k-bitcoins-worth-billions-much-ado-about-little-9777779.html",
          "note": null,
          "live": false
        },
        {
          "address": "bc1qnwft8re0tkkyekd4nl34dqvgmwx3zsfyxfadfg",
          "label": "BKA Movie2k.to funds",
          "sats": 10794,
          "source": "https://www.heise.de/en/news/Movie2k-bitcoins-worth-billions-much-ado-about-little-9777779.html",
          "note": null,
          "live": false
        },
        {
          "address": "bc1q9agtd4sk5r06vqcsy3ewdr0dslf03dlj3agtva",
          "label": "BKA Movie2k.to funds",
          "sats": 10500,
          "source": "https://www.heise.de/en/news/Movie2k-bitcoins-worth-billions-much-ado-about-little-9777779.html",
          "note": null,
          "live": false
        }
      ],
      "total": 53890
    },
    {
      "id": "blackrock-ibit",
      "name": "BlackRock iShares Bitcoin Trust (IBIT)",
      "category": "CORP",
      "icon": "corp",
      "badge": "ETF custody",
      "evidence": "attributed",
      "live": true,
      "description": "The largest spot bitcoin ETF. Coins arriving through Coinbase Prime custody settle into the IBIT wallets.",
      "extra": "Arkham attributes 6,738 addresses and 744,981 BTC (2026-11-28). The four below are custody addresses Arkham Research published itself and are a small part of that total; this is not IBIT's whole holding.",
      "addresses": [
        {
          "address": "bc1qvlk0r584m74kyf6tdq8r8es43w0e4y20sm2whg",
          "label": "IBIT custody",
          "sats": 30000000000,
          "source": "https://arkm.com/research/blackrock-records-six-straight-days-of-btc-inflows-1-5b",
          "note": "Arkham attribution, not a fund disclosure.",
          "live": true
        },
        {
          "address": "bc1qhug23ff3jy0lnuy27huz93rp70z9mcts48n4ev",
          "label": "IBIT custody",
          "sats": 30000000000,
          "source": "https://arkm.com/research/blackrock-records-six-straight-days-of-btc-inflows-1-5b",
          "note": null,
          "live": true
        },
        {
          "address": "bc1q382hvy72szks44e4qk8cy76qwhmddd3rcyx37n",
          "label": "IBIT custody",
          "sats": 30000000000,
          "source": "https://arkm.com/research/blackrock-records-six-straight-days-of-btc-inflows-1-5b",
          "note": null,
          "live": true
        },
        {
          "address": "bc1qgjuv5cmczcttpwy56gj6f46xehrjfw255y35f5",
          "label": "IBIT custody",
          "sats": 0,
          "source": "https://arkm.com/research/blackrock-records-six-straight-days-of-btc-inflows-1-5b",
          "note": "Deposited and moved on; balance 0.",
          "live": false
        }
      ],
      "total": 90000000000
    },
    {
      "id": "fidelity-fbtc",
      "name": "Fidelity Wise Origin Bitcoin Fund (FBTC)",
      "category": "CORP",
      "icon": "corp",
      "badge": "ETF custody",
      "evidence": "attributed",
      "live": true,
      "description": "Fidelity's spot bitcoin ETF. Arkham published FBTC inflow and custody addresses.",
      "extra": "Of the 23 addresses in Arkham's Fidelity FBTC ETF Inflows entity, only this published custody deposit address was verified.",
      "addresses": [
        {
          "address": "32oWtYcHLt1nVWPEtJe5z4g7E8bd1A7jTQ",
          "label": "Fidelity Custody Deposit",
          "sats": 34777005442,
          "source": "https://arkm.com/explorer/address/32oWtYcHLt1nVWPEtJe5z4g7E8bd1A7jTQ",
          "note": "Arkham attribution. Last moved 2026-11-25.",
          "live": true
        }
      ],
      "total": 34777005442
    },
    {
      "id": "binance",
      "name": "Binance",
      "category": "CORP",
      "icon": "corp",
      "badge": "Proof of reserves",
      "evidence": "official",
      "live": true,
      "description": "The largest exchange. Reserve wallets are published in its own proof-of-reserves material.",
      "extra": "The Binance PoR address list holds about 629,029 BTC over 95 addresses (CryptoKeyhole, 2026-11-28). The two below are the largest. The PoR file does not label hot or cold, so they are named PoR wallets, not cold wallets.",
      "addresses": [
        {
          "address": "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
          "label": "Binance PoR wallet (largest single address on chain)",
          "sats": 24859759296803,
          "source": "https://public.bnbstatic.com/static/proof-of-reserve/wallet_address_20261031.zip",
          "note": null,
          "live": true
        },
        {
          "address": "3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6",
          "label": "Binance PoR wallet",
          "sats": 16487839644777,
          "source": "https://chainquery.com/sources/binance-por",
          "note": null,
          "live": true
        }
      ],
      "total": 41347598941580
    },
    {
      "id": "bitfinex",
      "name": "Bitfinex",
      "category": "CORP",
      "icon": "corp",
      "badge": "Self-published",
      "evidence": "official",
      "live": true,
      "description": "The exchange publishes its BTC cold and hot wallet addresses in its own GitHub repository, the strongest disclosure tier there is.",
      "extra": null,
      "addresses": [
        {
          "address": "bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97",
          "label": "BTC cold wallet (self-published)",
          "sats": 15701008337263,
          "source": "https://github.com/bitfinexcom/pub/blob/main/wallets.txt",
          "note": null,
          "live": true
        },
        {
          "address": "1Kr6QSydW9bFQG1mXiPNNu6WpJGmUa9i1g",
          "label": "BTC hot wallet (self-published)",
          "sats": 102193173087,
          "source": "https://github.com/bitfinexcom/pub/blob/main/wallets.txt",
          "note": "Hot wallet with about 490,000 transactions; the balance moves often.",
          "live": true
        }
      ],
      "total": 15803201510350
    },
    {
      "id": "robinhood",
      "name": "Robinhood",
      "category": "CORP",
      "icon": "corp",
      "badge": "Customer custody",
      "evidence": "attributed",
      "live": true,
      "description": "U.S. stock and crypto app. Customer bitcoin sits in cold storage; the address is known from an Arkham label and 2023 press confirmation by the company.",
      "extra": "Arkham attributes 1,670,411 addresses and 185,007 BTC. This is the representative cold wallet that holds customer assets, not the company's own coins.",
      "addresses": [
        {
          "address": "bc1ql49ydapnjafl5t2cp9zqpjwe6pdgmxy98859v2",
          "label": "Robinhood customer cold storage",
          "sats": 14084998559801,
          "source": "https://satoshis.watch/bc1ql49ydapnjafl5t2cp9zqpjwe6pdgmxy98859v2",
          "note": "Customer assets, not the exchange's own holding.",
          "live": true
        }
      ],
      "total": 14084998559801
    },
    {
      "id": "mt-gox-trustee",
      "name": "Mt. Gox Trustee",
      "category": "OTHER",
      "icon": "group",
      "badge": "Distributed",
      "evidence": "attributed",
      "live": false,
      "description": "The estate of the exchange that failed in 2014. Creditor distributions through 2024 moved the money out.",
      "extra": "The trustee publishes no addresses. This is the transit wallet analysts tracked during the 2024 distributions, empty since 2026-06-02, so it is a historic card.",
      "addresses": [
        {
          "address": "1JbezDVd9VsK9o1Ga9UqLydeuEvhKLAPs6",
          "label": "Mt. Gox estate transfer hub",
          "sats": 0,
          "source": "https://satoshis.watch/1JbezDVd9VsK9o1Ga9UqLydeuEvhKLAPs6",
          "note": "About 141,000 BTC passed through in one day, 2024-05-28. Empty now.",
          "live": false
        }
      ],
      "total": 0
    },
    {
      "id": "luna-foundation-guard",
      "name": "Luna Foundation Guard (LFG)",
      "category": "OTHER",
      "icon": "group",
      "badge": "Reserve 2022",
      "evidence": "official",
      "live": true,
      "description": "The Terra non-profit whose bitcoin reserve backed the UST peg. LFG named this treasury address itself in September 2022.",
      "extra": "The reserve held 80,394 BTC on 2022-05-07 and spent almost all of it defending the peg within days. About 313 BTC remains, and the balance matches the JS Held audit of the reserve.",
      "addresses": [
        {
          "address": "bc1q9d4ywgfnd8h43da5tpcxcn6ajv590cg6d3tg6axemvljvt2k76zs50tv4q",
          "label": "LFG treasury (named by LFG, 2022-09)",
          "sats": 31305620571,
          "source": "https://www.lfg.org/audit/LFG-Audit-2022-11-14.pdf",
          "note": "Received 71,049.43 BTC in total and spent 70,736.37 BTC in May 2022.",
          "live": true
        }
      ],
      "total": 31305620571
    },
    {
      "id": "silk-road",
      "name": "Silk Road (FBI seizure)",
      "category": "OTHER",
      "icon": "hacker",
      "badge": "Seized 2013",
      "evidence": "attributed",
      "live": true,
      "description": "The marketplace wallet the FBI seized in 2013. Most of the money later moved to U.S. Government wallets.",
      "extra": "29,679.67 BTC passed through and most of it left between 2013 and 2015. The 0.3306 BTC left is residue and small deposits. The seized bulk is tracked under U.S. Government.",
      "addresses": [
        {
          "address": "1F1tAaz5x1HUXrCNLbtMDqcw6o5GNn4xqX",
          "label": "FBI-controlled Silk Road seized funds",
          "sats": 33061617,
          "source": "https://www.walletexplorer.com/address/1F1tAaz5x1HUXrCNLbtMDqcw6o5GNn4xqX",
          "note": null,
          "live": true
        }
      ],
      "total": 33061617
    },
    {
      "id": "mt-gox-hacker",
      "name": "Mt. Gox Hacker (1Feex)",
      "category": "OTHER",
      "icon": "hacker",
      "badge": "Dormant",
      "evidence": "chain",
      "live": true,
      "description": "The address that received about 80,000 BTC when the Mt. Gox hot wallet was emptied on 2011-03-01. Nothing has ever left it.",
      "extra": "Mark Karpeles publicly certified the transfer as unauthorised on 2023-08-01, and WizSec's forensic work traces it to a copied wallet.dat. The owner is unknown and the key may be lost; the coins have not moved in more than 15 years.",
      "addresses": [
        {
          "address": "1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF",
          "label": "Mt. Gox theft destination (2011-03-01)",
          "sats": 7995726874324,
          "source": "https://blog.wizsec.jp/2020/06/mtgox-march-2011-theft.html",
          "note": "79,957.27 BTC, never spent. The 2011 Mt. Gox theft; whose key controls it is unknown.",
          "live": true
        }
      ],
      "total": 7995726874324
    },
    {
      "id": "bitfinex-hacker",
      "name": "Bitfinex Hacker (2016)",
      "category": "OTHER",
      "icon": "hacker",
      "badge": "Seized 2022",
      "evidence": "attributed",
      "live": false,
      "description": "A receiving wallet of the August 2016 Bitfinex breach, in which about 119,754 BTC left the exchange in more than 2,000 transactions.",
      "extra": "The DOJ statement of facts names only the prefix Wallet 1CGA4s; the full address comes from the public CSV of the 2,072 unauthorised transactions and matches that prefix. The coins were seized in 2022 and are tracked under U.S. Government, so this card is history.",
      "addresses": [
        {
          "address": "1CGA4srJbPWhtJb7ezgY6GQf4PKhFuzD9w",
          "label": "Bitfinex hack destination (Wallet 1CGA4s)",
          "sats": 0,
          "source": "https://degreesofsatoshi.com/wallet/bitfinex-2016-hack-destination-addresses/",
          "note": "Received 567.49 BTC in the hack and moved all of it to the consolidation wallet later seized. Balance 0.",
          "live": false
        }
      ],
      "total": 0
    },
    {
      "id": "wannacry",
      "name": "WannaCry Ransom Wallets",
      "category": "OTHER",
      "icon": "hacker",
      "badge": "Ransom 2017",
      "evidence": "official",
      "live": true,
      "description": "The three bitcoin addresses hard-coded into the WannaCry ransomware that spread worldwide from 2017-05-12. Victims paid the ransom here.",
      "extra": "The addresses come from the malware's own configuration, as published by INCIBE-CERT and ENISA in May 2017. Payments were never laundered in a publicly traced way, and the wallets still receive the occasional payment.",
      "addresses": [
        {
          "address": "115p7UMMngoj1pMvkpHijcRdfJNXj6LrLn",
          "label": "WannaCry ransom address 1 (hard-coded in the malware)",
          "sats": 46702392,
          "source": "https://www.nksc.lt/doc/ENISA-WannaCry-v1.0.pdf",
          "note": "Documented by ENISA (ThaiCERT) and INCIBE-CERT in May 2017.",
          "live": true
        },
        {
          "address": "12t9YDPgwueZ9NyMgw519p7AA8isjr6SMw",
          "label": "WannaCry ransom address 2 (hard-coded in the malware)",
          "sats": 192242576,
          "source": "https://www.nksc.lt/doc/ENISA-WannaCry-v1.0.pdf",
          "note": "Documented by ENISA (ThaiCERT) and INCIBE-CERT in May 2017.",
          "live": true
        },
        {
          "address": "13AM4VW2dhxYgXeQepoHkHSQuy6NgaEb94",
          "label": "WannaCry ransom address 3 (hard-coded in the malware)",
          "sats": 32943048,
          "source": "https://www.nksc.lt/doc/ENISA-WannaCry-v1.0.pdf",
          "note": "Documented by ENISA (ThaiCERT) and INCIBE-CERT in May 2017.",
          "live": true
        }
      ],
      "total": 271888016
    }
  ]
};
