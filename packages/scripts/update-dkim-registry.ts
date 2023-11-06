import { ethers, JsonRpcProvider } from "ethers";
import { buildPoseidon } from "circomlibjs";
import dns from "dns";
import forge from "node-forge";
import { bigIntToChunkedBytes } from "@zk-email/helpers/src/binaryFormat";
const fs = require("fs");
import { abi } from "@zk-email/contracts/out/DKIMRegistry.sol/DKIMRegistry.json";
require("dotenv").config();

async function updateContract(domain: string, pubkeyHashes: string[]) {
  if (!pubkeyHashes.length) {
    return;
  }

  if (!process.env.PRIVATE_KEY) throw new Error("Env private key found");
  if (!process.env.RPC_URL) throw new Error("Env RPC URL found");
  if (!process.env.DKIM_REGISTRY) throw new Error("Env DKIM_REGISTRY found");

  const provider = new JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const contract = new ethers.Contract(process.env.DKIM_REGISTRY, abi, wallet);

  const hashes = pubkeyHashes.map((hash) => BigInt(hash));
  const tx = await contract.setDKIMPublicKeyHashes(domain, hashes);
  await tx.wait();

  console.log(`Updated hashes for domain ${domain}. Tx: ${tx.hash}`);
}

async function getPublicKeyForDomainAndSelector(
  domain: string,
  selector: string,
  print: boolean = true
) {
  // Construct the DKIM record name
  let dkimRecordName = `${selector}._domainkey.${domain}`;
  if (print) console.log(dkimRecordName);
  // Lookup the DKIM record in DNS
  let records;
  try {
    records = await dns.promises.resolveTxt(dkimRecordName);
  } catch (err) {
    if (print) console.error(err);
    return;
  }

  if (!records.length) {
    return;
  }

  // The DKIM record is a TXT record containing a string
  // We need to parse this string to get the public key
  let dkimRecord = records[0].join("");
  let match = dkimRecord.match(/p=([^;]+)/);
  if (!match) {
    console.error("No public key found in DKIM record");
    return;
  }

  // The public key is base64 encoded, we need to decode it
  let pubkey = match[1];
  let binaryKey = Buffer.from(pubkey, "base64").toString("base64");

  // Get match
  let matches = binaryKey.match(/.{1,64}/g);
  if (!matches) {
    console.error("No matches found");
    return;
  }
  let formattedKey = matches.join("\n");
  if (print) console.log("Key: ", formattedKey);

  // Convert to PEM format
  let pemKey = `-----BEGIN PUBLIC KEY-----\n${formattedKey}\n-----END PUBLIC KEY-----`;

  // Parse the RSA public key
  let publicKey = forge.pki.publicKeyFromPem(pemKey);

  // Get the modulus n only
  let n = publicKey.n;
  if (print) console.log("Modulus n:", n.toString(16));

  return BigInt(publicKey.n.toString());
}

async function checkSelector(domain: string, selector: string) {
  try {
    const publicKey = await getPublicKeyForDomainAndSelector(
      domain,
      selector,
      false
    );
    if (publicKey) {
      console.log(`Domain: ${domain}, Selector: ${selector} - Match found`);
      return {
        match: true,
        selector: selector,
        domain: domain,
        publicKey,
      };
    } else {
      // console.log(`Domain: ${domain}, Selector: ${selector} - No match found`);
    }
  } catch (error) {
    console.error(
      `Error processing domain: ${domain}, Selector: ${selector} - ${error}`
    );
  }

  return {
    match: false,
    selector: selector,
    domain: domain,
    publicKey: null,
  };
}

// Filename is a file where each line is a domain
// This searches for default selectors like "google" or "default"
async function getDKIMPublicKeysForDomains(filename: string) {
  const domains = fs.readFileSync(filename, "utf8").split("\n");
  const selectors = [
    "google",
    "default",
    "mail",
    "smtpapi",
    "dkim",
    "200608",
    "20230601",
    "20221208",
    "20210112",
    "v1",
    "v2",
    "v3",
    "k1",
    "k2",
    "k3",
    "hs1",
    "hs2",
    "s1",
    "s2",
    "s3",
    "sig1",
    "sig2",
    "sig3",
    "selector",
    "selector1",
    "selector2",
    "mindbox",
    "bk",
    "sm1",
    "sm2",
    "gmail",
    "10dkim1",
    "11dkim1",
    "12dkim1",
    "memdkim",
    "m1",
    "mx",
    "sel1",
    "bk",
    "scph1220",
    "ml",
    "pps1",
    "scph0819",
    "skiff1",
    "s1024",
    "selector1",
  ];

  let results = [];

  for (let domain of domains) {
    const promises = [];
    for (let selector of selectors) {
      promises.push(checkSelector(domain, selector));
    }
    results.push(...(await Promise.all(promises)));
  }

  const matchedSelectors: { [key: string]: string[] } = {};

  for (let result of results) {
    if (result.match && result.publicKey) {
      if (!matchedSelectors[result.domain]) {
        matchedSelectors[result.domain] = [];
      }

      const publicKey = result.publicKey.toString();

      if (!matchedSelectors[result.domain].includes(publicKey)) {
        matchedSelectors[result.domain].push(publicKey);
      }
    }
  }

  return matchedSelectors;
}

async function updateDKIMRegistry(
  { writeToFile } = {
    writeToFile: false,
  }
) {
  const domainsFile = "./domains.txt";
  const domainPubKeyMap = await getDKIMPublicKeysForDomains(domainsFile);

  if (writeToFile) {
    fs.writeFileSync(
      "out/domain-dkim-keys.json",
      JSON.stringify(domainPubKeyMap, null, 2)
    );
  }

  // const domainPubKeyMap = JSON.parse(
  //   fs.readFileSync("out/domain-dkim-keys.json").toString()
  // );

  // Saving pubkeys into chunks of 121 * 17
  // This is what is used in EmailVerifier.cicrom
  // Can be used at https://zkrepl.dev/?gist=43ce7dce2466c63812f6efec5b13aa73 to get pubkey hash
  const chunkedDKIMPubKeyMap: { [key: string]: string[][] } = {};
  for (let domain of Object.keys(domainPubKeyMap)) {
    for (let publicKey of domainPubKeyMap[domain]) {
      const pubkeyChunked = bigIntToChunkedBytes(BigInt(publicKey), 121, 17);

      if (!chunkedDKIMPubKeyMap[domain]) {
        chunkedDKIMPubKeyMap[domain] = [];
      }
      chunkedDKIMPubKeyMap[domain].push(pubkeyChunked.map((s) => s.toString()));
    }
  }
  if (writeToFile) {
    fs.writeFileSync(
      "out/domain-dkim-keys-chunked.json",
      JSON.stringify(chunkedDKIMPubKeyMap, null, 2)
    );
  }

  // Generate pub key hash using 242 * 9 chunks (Poseidon lib don't take more than 16 inputs)
  const domainHashedPubKeyMap: { [key: string]: string[] } = {};
  const poseidon = await buildPoseidon();
  for (let domain of Object.keys(domainPubKeyMap)) {
    for (let publicKey of domainPubKeyMap[domain]) {
      const pubkeyChunked = bigIntToChunkedBytes(BigInt(publicKey), 242, 9);
      const hash = poseidon(pubkeyChunked);

      if (!domainHashedPubKeyMap[domain]) {
        domainHashedPubKeyMap[domain] = [];
      }
      domainHashedPubKeyMap[domain].push(poseidon.F.toObject(hash).toString());
    }
  }
  if (writeToFile) {
    fs.writeFileSync(
      "out/domain-dkim-key-hashes.json",
      JSON.stringify(domainHashedPubKeyMap, null, 2)
    );
  }

  // Update Mailserver contract with found keys
  for (let domain of Object.keys(domainHashedPubKeyMap)) {
    await updateContract(domain, domainHashedPubKeyMap[domain]);
  }
}

updateDKIMRegistry({ writeToFile: true });
