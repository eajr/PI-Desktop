import { describe, expect, it } from "vitest";
import {
  classifyNetHost,
  isLocalNetDomain,
  isMetadataNetHost,
  isNetAddressAllowedWithGrant,
  isNetHostAllowed,
  isNetSocketUrlAllowedWithGrant,
  isNetUrlAllowed,
  isNetUrlAllowedWithGrant,
  normalizeNetHost,
  parseNetDomains,
} from "./net-policy.js";

describe("parseNetDomains", () => {
  it("treats an absent list as no egress rather than an error", () => {
    expect(parseNetDomains(undefined)).toEqual({ ok: true, domains: [] });
    expect(parseNetDomains([])).toEqual({ ok: true, domains: [] });
  });

  it("normalizes case and drops duplicates", () => {
    expect(parseNetDomains(["API.GitHub.com", "api.github.com"])).toEqual({
      ok: true,
      domains: ["api.github.com"],
    });
  });

  it("accepts a subdomain wildcard", () => {
    expect(parseNetDomains(["*.example.com"]).domains).toEqual(["*.example.com"]);
  });

  it("rejects a bare wildcard so nobody declares their way to every host", () => {
    const result = parseNetDomains(["*"]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must not contain/);
  });

  it("rejects anything that is not a bare hostname", () => {
    for (const entry of [
      "https://api.github.com",
      "api.github.com/v3",
      "api.github.com:443",
      "api..github.com",
      "-github.com",
      "",
    ]) {
      expect(parseNetDomains([entry]).ok, entry).toBe(false);
    }
  });

  it("rejects non-array and non-string input", () => {
    expect(parseNetDomains("api.github.com").ok).toBe(false);
    expect(parseNetDomains([1]).ok).toBe(false);
  });
});

describe("isLocalNetDomain", () => {
  it("flags loopback, link-local, and cloud metadata hosts", () => {
    for (const entry of [
      "localhost",
      "*.localhost",
      "app.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "169.254.169.254",
      "169.254.0.7",
      "metadata.google.internal",
      "LOCALHOST.",
    ]) {
      expect(isLocalNetDomain(entry), entry).toBe(true);
    }
  });

  it("leaves public hosts alone", () => {
    for (const entry of [
      "api.github.com",
      "*.example.com",
      "10.0.0.1",
      "192.168.1.1",
      "localhost.example.com",
      "metadata.example.com",
    ]) {
      expect(isLocalNetDomain(entry), entry).toBe(false);
    }
  });
});

describe("isNetHostAllowed", () => {
  it("matches an exact host only", () => {
    expect(isNetHostAllowed("api.github.com", ["api.github.com"])).toBe(true);
    expect(isNetHostAllowed("evil.com", ["api.github.com"])).toBe(false);
  });

  it("matches the apex and its subdomains for a wildcard", () => {
    const domains = ["*.example.com"];
    expect(isNetHostAllowed("example.com", domains)).toBe(true);
    expect(isNetHostAllowed("a.b.example.com", domains)).toBe(true);
  });

  it("does not let a suffix collision through", () => {
    // The classic bug: endsWith("example.com") also matches notexample.com.
    expect(isNetHostAllowed("notexample.com", ["*.example.com"])).toBe(false);
    expect(isNetHostAllowed("example.com.evil.net", ["*.example.com"])).toBe(false);
  });

  it("allows nothing when the list is empty", () => {
    expect(isNetHostAllowed("api.github.com", [])).toBe(false);
  });
});

describe("isNetUrlAllowed", () => {
  it("allows an http(s) url whose host is declared", () => {
    expect(isNetUrlAllowed("https://api.github.com/user", ["api.github.com"])).toBe(true);
    expect(isNetUrlAllowed("http://api.github.com/user", ["api.github.com"])).toBe(true);
  });

  it("ignores userinfo and port when matching the host", () => {
    expect(isNetUrlAllowed("https://evil.com@api.github.com/", ["api.github.com"])).toBe(
      true,
    );
    expect(isNetUrlAllowed("https://api.github.com:8443/", ["api.github.com"])).toBe(true);
    // ...and the reverse must not sneak past: the real host is evil.com.
    expect(isNetUrlAllowed("https://api.github.com@evil.com/", ["api.github.com"])).toBe(
      false,
    );
  });

  it("refuses non-http schemes and unparseable input", () => {
    expect(isNetUrlAllowed("ws://api.github.com", ["api.github.com"])).toBe(false);
    expect(isNetUrlAllowed("file:///etc/passwd", ["api.github.com"])).toBe(false);
    expect(isNetUrlAllowed("not a url", ["api.github.com"])).toBe(false);
  });
});

describe("isMetadataNetHost", () => {
  it("recognizes cloud metadata endpoints", () => {
    for (const host of ["169.254.169.254", "metadata.google.internal", "metadata", "METADATA."]) {
      expect(isMetadataNetHost(host), host).toBe(true);
    }
  });

  it("leaves ordinary and private hosts alone", () => {
    for (const host of ["api.github.com", "192.168.1.10", "10.0.0.1", "localhost"]) {
      expect(isMetadataNetHost(host), host).toBe(false);
    }
  });
});

describe("isNetUrlAllowedWithGrant", () => {
  it("keeps the allowlist decision unchanged without the grant", () => {
    const grant = { domains: ["api.github.com"], anyHost: false };
    expect(isNetUrlAllowedWithGrant("https://api.github.com/x", grant)).toBe(true);
    expect(isNetUrlAllowedWithGrant("https://my-self-hosted.example/x", grant)).toBe(false);
  });

  it("admits any public http(s) host once the grant is held", () => {
    const grant = { domains: [], anyHost: true };
    expect(isNetUrlAllowedWithGrant("https://my-self-hosted.example:8443/x", grant)).toBe(true);
    expect(isNetUrlAllowedWithGrant("https://93.184.216.34/x", grant)).toBe(true);
  });

  it("does not stretch the grant to loopback, link-local or private literals", () => {
    const grant = { domains: [], anyHost: true };
    for (const url of [
      "http://192.168.1.10/api",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://127.0.0.1:8080/",
      "http://0x7f000001/",
      "http://2130706433/",
      "http://127.1/",
      "http://0.0.0.0/",
      "http://localhost:3000/",
      "http://app.localhost/",
      "http://[::1]/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[fe80::1]/",
      "http://[fd12:3456::1]/",
    ]) {
      expect(isNetUrlAllowedWithGrant(url, grant), url).toBe(false);
    }
  });

  it("admits a local host the manifest names, under the grant or not", () => {
    for (const anyHost of [true, false]) {
      const grant = { domains: ["192.168.1.10", "nas.lan"], anyHost };
      expect(isNetUrlAllowedWithGrant("http://192.168.1.10/api", grant)).toBe(true);
      expect(isNetUrlAllowedWithGrant("http://nas.lan/api", grant)).toBe(true);
    }
  });

  it("never admits cloud metadata endpoints, grant or not", () => {
    const grant = { domains: [], anyHost: true };
    expect(isNetUrlAllowedWithGrant("http://169.254.169.254/latest/meta-data", grant)).toBe(false);
    expect(isNetUrlAllowedWithGrant("http://metadata.google.internal/", grant)).toBe(false);
  });

  it("refuses every alternate spelling of a metadata address", () => {
    const grant = { domains: [], anyHost: true };
    for (const url of [
      "http://[::ffff:a9fe:a9fe]/latest/meta-data",
      "http://[::ffff:169.254.169.254]/",
      "http://[::169.254.169.254]/",
      "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
      "http://0xa9fea9fe/",
      "http://2852039166/",
      "http://0251.0376.0251.0376/",
      "http://169.254.43518/",
      "http://0xa9.0xfe.0xa9.0xfe/",
      "http://169.254.169.254./",
      "http://100.100.100.200/",
      "http://[fd00:ec2::254]/",
      "http://[fd00:0ec2:0:0:0:0:0:0254]/",
      "http://METADATA.google.internal./",
    ]) {
      expect(isNetUrlAllowedWithGrant(url, grant), url).toBe(false);
      expect(isNetUrlAllowedWithGrant(url, { domains: [] }), url).toBe(false);
    }
  });

  it("still refuses non-http schemes and unparseable input under the grant", () => {
    const grant = { domains: [], anyHost: true };
    expect(isNetUrlAllowedWithGrant("file:///etc/passwd", grant)).toBe(false);
    expect(isNetUrlAllowedWithGrant("ws://my-self-hosted.example", grant)).toBe(false);
    expect(isNetUrlAllowedWithGrant("not a url", grant)).toBe(false);
  });

  it("refuses a metadata endpoint even when the manifest declares it", () => {
    for (const anyHost of [true, false]) {
      const grant = { domains: ["169.254.169.254", "metadata.google.internal"], anyHost };
      expect(isNetUrlAllowedWithGrant("http://169.254.169.254/latest/meta-data", grant)).toBe(false);
      expect(isNetUrlAllowedWithGrant("http://metadata.google.internal/", grant)).toBe(false);
    }
  });
});

describe("isNetSocketUrlAllowedWithGrant", () => {
  it("admits any ws(s) host under the grant, metadata excepted", () => {
    const grant = { domains: [], anyHost: true };
    expect(isNetSocketUrlAllowedWithGrant("wss://my-self-hosted.example/ws", grant)).toBe(true);
    expect(isNetSocketUrlAllowedWithGrant("http://my-self-hosted.example", grant)).toBe(false);
    expect(isNetSocketUrlAllowedWithGrant("ws://169.254.169.254/", grant)).toBe(false);
    expect(isNetSocketUrlAllowedWithGrant("ws://[::ffff:a9fe:a9fe]/", grant)).toBe(false);
    expect(isNetSocketUrlAllowedWithGrant("ws://0xa9fea9fe/", grant)).toBe(false);
    expect(isNetSocketUrlAllowedWithGrant("ws://127.0.0.1:9000/", grant)).toBe(false);
  });

  it("changes nothing without the grant", () => {
    const grant = { domains: ["api.github.com"] };
    expect(isNetSocketUrlAllowedWithGrant("wss://api.github.com/ws", grant)).toBe(true);
    expect(isNetSocketUrlAllowedWithGrant("wss://other.example/ws", grant)).toBe(false);
  });
});

describe("normalizeNetHost", () => {
  it("folds every IPv4 spelling to a dotted quad", () => {
    for (const host of [
      "169.254.169.254",
      "0xa9fea9fe",
      "0xA9FEA9FE",
      "2852039166",
      "0251.0376.0251.0376",
      "169.254.43518",
      "169.16689662",
      "0xa9.0xfe.0xa9.0xfe",
      "169.254.169.254.",
      "[::ffff:a9fe:a9fe]",
      "::ffff:169.254.169.254",
      "[::169.254.169.254]",
      "0:0:0:0:0:ffff:a9fe:a9fe",
    ]) {
      expect(normalizeNetHost(host), host).toBe("169.254.169.254");
    }
  });

  it("gives one spelling to one IPv6 address and leaves names alone", () => {
    expect(normalizeNetHost("[FD00:0EC2::0254]")).toBe("fd00:ec2:0:0:0:0:0:254");
    expect(normalizeNetHost("fd00:ec2:0:0:0:0:0:254")).toBe("fd00:ec2:0:0:0:0:0:254");
    expect(normalizeNetHost("[::1]")).toBe("0:0:0:0:0:0:0:1");
    expect(normalizeNetHost("API.GitHub.com.")).toBe("api.github.com");
    expect(normalizeNetHost("1.2.3.4.example")).toBe("1.2.3.4.example");
    expect(normalizeNetHost("256.1.1.1")).toBe("256.1.1.1");
    expect(normalizeNetHost("08.1.1.1")).toBe("08.1.1.1");
  });
});

describe("classifyNetHost", () => {
  it("separates metadata, local and other hosts", () => {
    expect(classifyNetHost("[::ffff:a9fe:a9fe]")).toBe("metadata");
    expect(classifyNetHost("fd00:ec2::254")).toBe("metadata");
    expect(classifyNetHost("100.100.100.200")).toBe("metadata");
    expect(classifyNetHost("instance-data")).toBe("metadata");
    for (const host of [
      "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.31.255.255", "192.168.0.1", "169.254.1.1",
      "::1", "::", "fe80::1", "fc00::1", "fec0::1", "::ffff:10.0.0.1", "localhost",
    ]) {
      expect(classifyNetHost(host), host).toBe("local");
    }
    for (const host of ["8.8.8.8", "172.32.0.1", "100.64.0.1", "2606:4700::1111", "api.github.com"]) {
      expect(classifyNetHost(host), host).toBe("other");
    }
  });
});

describe("isNetAddressAllowedWithGrant", () => {
  it("always refuses a metadata answer, even for a declared host", () => {
    const grant = { domains: ["innocent.example"], anyHost: true };
    for (const address of ["169.254.169.254", "100.100.100.200", "fd00:ec2::254", "::ffff:a9fe:a9fe"]) {
      expect(isNetAddressAllowedWithGrant("innocent.example", address, grant), address).toBe(false);
    }
  });

  it("admits a local answer only for a host the manifest names", () => {
    const grant = { domains: ["nas.lan", "*.corp.example"], anyHost: true };
    expect(isNetAddressAllowedWithGrant("nas.lan", "192.168.1.10", grant)).toBe(true);
    expect(isNetAddressAllowedWithGrant("git.corp.example", "10.0.0.5", grant)).toBe(true);
    expect(isNetAddressAllowedWithGrant("rebind.attacker.example", "127.0.0.1", grant)).toBe(false);
    expect(isNetAddressAllowedWithGrant("rebind.attacker.example", "::1", grant)).toBe(false);
    expect(isNetAddressAllowedWithGrant("rebind.attacker.example", "192.168.1.1", grant)).toBe(false);
  });

  it("admits a public answer", () => {
    const grant = { domains: [], anyHost: true };
    expect(isNetAddressAllowedWithGrant("self-hosted.example", "93.184.216.34", grant)).toBe(true);
    expect(isNetAddressAllowedWithGrant("self-hosted.example", "2606:4700::1111", grant)).toBe(true);
  });
});
