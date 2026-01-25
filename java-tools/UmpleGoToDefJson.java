import cruise.umple.compiler.Attribute;
import cruise.umple.compiler.UmpleClass;
import cruise.umple.compiler.UmpleFile;
import cruise.umple.compiler.UmpleInterface;
import cruise.umple.compiler.UmpleInternalParser;
import cruise.umple.compiler.UmpleModel;
import cruise.umple.compiler.UmpleTrait;
import cruise.umple.parser.ParseResult;
import cruise.umple.parser.Position;
import cruise.umple.parser.Token;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class UmpleGoToDefJson {
  public static void main(String[] args) throws Exception {
    if (args.length == 1 && "--server".equals(args[0])) {
      runServer();
      return;
    }
    if (args.length < 3) {
      System.out.println("{\"found\":false}");
      return;
    }

    String filename = args[0];
    int line = Integer.parseInt(args[1]);
    int col = Integer.parseInt(args[2]);

    File inputFile = new File(filename);
    if (!inputFile.isFile()) {
      System.out.println("{\"found\":false}");
      return;
    }
    UmpleFile umpleFile = new UmpleFile(filename);
    UmpleModel model = new UmpleModel(umpleFile);

    UmpleInternalParser modelParser = new UmpleInternalParser();
    modelParser.setModel(model);
    modelParser.setFilename(filename);
    ParseResult result = modelParser.getParser().parse(inputFile);
    modelParser.setParseResult(result);
    modelParser.setRootToken(modelParser.getParser().getRootToken());
    modelParser.analyze(false);

    // Need to sanitize the 'use' statements in order to get the proper token at the location
    String text = Files.readString(inputFile.toPath());
    String sanitized = sanitizeUseStatements(text);
    Position start = new Position(filename, 1, 0, 0);
    UmpleInternalParser astParser = new UmpleInternalParser();
    astParser.setFilename(filename);
    astParser.parse("program", sanitized, filename, start, 0, 0);
    Token root = astParser.getRootToken();
    Token token = findTokenAt(root, line, col, filename);
    if (token == null) {
      System.out.println("{\"found\":false}");
      return;
    }
    DefLocation def = resolveDefinition(token, model, filename, line, col);
    if (def == null) {
      System.out.println("{\"found\":false}");
      return;
    }

    System.out.println(def.toJson());
  }

  private static class CacheEntry {
    String semanticHash;
    UmpleModel model;

    CacheEntry(String semanticHash, UmpleModel model) {
      this.semanticHash = semanticHash;
      this.model = model;
    }
  }

  private static class Request {
    int id;
    String file;
    int line;
    int col;
  }

  private static final Map<String, CacheEntry> MODEL_CACHE = new HashMap<>();

  private static void runServer() throws Exception {
    // Simple line-based JSON protocol over stdin/stdout.
    BufferedReader reader = new BufferedReader(
      new InputStreamReader(System.in, StandardCharsets.UTF_8)
    );
    String line;
    while ((line = reader.readLine()) != null) {
      line = line.trim();
      if (line.isEmpty()) {
        continue;
      }
      Request request = parseRequest(line);
      if (request == null) {
        System.out.println("{\"found\":false}");
        System.out.flush();
        continue;
      }

      DefLocation def = handleRequest(request);
      if (def == null) {
        System.out.println("{\"id\":" + request.id + ",\"found\":false}");
      } else {
        System.out.println(def.toJsonWithId(request.id));
      }
      System.out.flush();
    }
  }

  private static DefLocation handleRequest(Request request) throws Exception {
    File inputFile = new File(request.file);
    if (!inputFile.isFile()) {
      return null;
    }
    String text = Files.readString(inputFile.toPath());
    String semanticHash = hashSemantic(text);

    CacheEntry cached = MODEL_CACHE.get(request.file);
    if (cached == null || !semanticHash.equals(cached.semanticHash)) {
      // Rebuild the model only when semantic content changes.
      UmpleFile umpleFile = new UmpleFile(request.file);
      UmpleModel model = new UmpleModel(umpleFile);
      UmpleInternalParser modelParser = new UmpleInternalParser();
      modelParser.setModel(model);
      modelParser.setFilename(request.file);
      ParseResult result = modelParser.getParser().parse(inputFile);
      modelParser.setParseResult(result);
      modelParser.setRootToken(modelParser.getParser().getRootToken());
      modelParser.analyze(false);
      cached = new CacheEntry(semanticHash, model);
      MODEL_CACHE.put(request.file, cached);
    }

    String sanitized = sanitizeUseStatements(text);
    Position start = new Position(request.file, 1, 0, 0);
    UmpleInternalParser astParser = new UmpleInternalParser();
    astParser.setFilename(request.file);
    astParser.parse("program", sanitized, request.file, start, 0, 0);
    Token root = astParser.getRootToken();
    Token token = findTokenAt(root, request.line, request.col, request.file);
    if (token == null) {
      return null;
    }

    return resolveDefinition(token, cached.model, request.file, request.line, request.col);
  }

  private static Request parseRequest(String line) {
    Request req = new Request();
    req.file = extractJsonString(line, "file");
    Integer id = extractJsonInt(line, "id");
    Integer lineNum = extractJsonInt(line, "line");
    Integer colNum = extractJsonInt(line, "col");
    if (req.file == null || id == null || lineNum == null || colNum == null) {
      return null;
    }
    req.id = id.intValue();
    req.line = lineNum.intValue();
    req.col = colNum.intValue();
    return req;
  }

  private static String extractJsonString(String line, String key) {
    Pattern pattern = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"([^\"]*)\"");
    Matcher matcher = pattern.matcher(line);
    if (!matcher.find()) {
      return null;
    }
    return unescapeJson(matcher.group(1));
  }

  private static Integer extractJsonInt(String line, String key) {
    Pattern pattern = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*(\\d+)");
    Matcher matcher = pattern.matcher(line);
    if (!matcher.find()) {
      return null;
    }
    return Integer.valueOf(matcher.group(1));
  }

  private static String unescapeJson(String value) {
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < value.length(); i += 1) {
      char c = value.charAt(i);
      if (c != '\\' || i + 1 >= value.length()) {
        out.append(c);
        continue;
      }
      char next = value.charAt(i + 1);
      switch (next) {
        case 'n':
          out.append('\n');
          break;
        case 'r':
          out.append('\r');
          break;
        case 't':
          out.append('\t');
          break;
        case '\\':
          out.append('\\');
          break;
        case '"':
          out.append('"');
          break;
        default:
          out.append(next);
          break;
      }
      i += 1;
    }
    return out.toString();
  }

  private static String hashSemantic(String text) throws Exception {
    // Hash normalized content so whitespace-only edits are ignored.
    String normalized = normalizeForHash(text);
    MessageDigest digest = MessageDigest.getInstance("SHA-1");
    byte[] bytes = digest.digest(normalized.getBytes(StandardCharsets.UTF_8));
    StringBuilder out = new StringBuilder();
    for (byte b : bytes) {
      out.append(String.format("%02x", b));
    }
    return out.toString();
  }

  private static String normalizeForHash(String text) {
    // Strip comments and collapse whitespace outside of strings.
    StringBuilder out = new StringBuilder();
    boolean inLine = false;
    boolean inBlock = false;
    boolean inString = false;
    char stringQuote = 0;
    boolean lastSpace = false;

    for (int i = 0; i < text.length(); i += 1) {
      char c = text.charAt(i);
      char next = i + 1 < text.length() ? text.charAt(i + 1) : '\0';

      if (inLine) {
        if (c == '\n') {
          inLine = false;
        }
        continue;
      }
      if (inBlock) {
        if (c == '*' && next == '/') {
          inBlock = false;
          i += 1;
        }
        continue;
      }

      if (!inString && c == '/' && next == '/') {
        inLine = true;
        i += 1;
        continue;
      }
      if (!inString && c == '/' && next == '*') {
        inBlock = true;
        i += 1;
        continue;
      }

      if (!inString && (c == '"' || c == '\'')) {
        inString = true;
        stringQuote = c;
        out.append(c);
        lastSpace = false;
        continue;
      }
      if (inString) {
        out.append(c);
        if (c == '\\' && next != '\0') {
          out.append(next);
          i += 1;
          continue;
        }
        if (c == stringQuote) {
          inString = false;
        }
        continue;
      }

      if (Character.isWhitespace(c)) {
        if (!lastSpace) {
          out.append(' ');
          lastSpace = true;
        }
        continue;
      }

      out.append(c);
      lastSpace = false;
    }

    return out.toString().trim();
  }

  private static DefLocation resolveDefinition(
    Token token,
    UmpleModel model,
    String sourceFile,
    int line,
    int col
  ) {
    Token classDef = findAncestor(token, "classDefinition");
    String className = classDef != null ? getChildValue(classDef, "name") : null;
    if (className != null) {
      String identifier = extractIdentifierAt(sourceFile, line, col);
      UmpleClass cls = model.getUmpleClass(className);
      if (cls != null && identifier != null) {
        Attribute attr = cls.getAttribute(identifier);
        if (attr != null && attr.hasPosition()) {
          Position pos = attr.getPosition();
          return new DefLocation("attribute", identifier, pos);
        }
      }
    }
    String lookupName = token.getValue();
    if (lookupName == null || lookupName.isEmpty()) {
      lookupName = extractIdentifierAt(sourceFile, line, col);
    }
    if (lookupName == null || lookupName.isEmpty()) {
      return null;
    }

    UmpleClass cls = model.getUmpleClass(lookupName);
    if (cls != null && cls.hasPosition()) {
      Position pos = cls.getPosition(0);
      DefLocation def = new DefLocation("class", lookupName, pos);
      return adjustDefinitionLocation(def, sourceFile);
    }

    UmpleInterface ui = model.getUmpleInterface(lookupName);
    if (ui != null && ui.hasPosition()) {
      Position pos = ui.getPosition(0);
      DefLocation def = new DefLocation("interface", lookupName, pos);
      return adjustDefinitionLocation(def, sourceFile);
    }

    UmpleTrait trait = model.getUmpleTrait(lookupName);
    if (trait != null && trait.hasPosition()) {
      Position pos = trait.getPosition(0);
      DefLocation def = new DefLocation("trait", lookupName, pos);
      return adjustDefinitionLocation(def, sourceFile);
    }

    return null;
  }

  private static String extractIdentifierAt(String filename, int line, int col) {
    try {
      List<String> lines = Files.readAllLines(Paths.get(filename));
      int index = line - 1;
      if (index < 0 || index >= lines.size()) {
        return null;
      }
      String text = lines.get(index);
      return extractIdentifierAtLine(text, col);
    } catch (Exception e) {
      return null;
    }
  }

  private static String extractIdentifierAtLine(String text, int col) {
    if (text == null || text.isEmpty()) {
      return null;
    }
    int length = text.length();
    if (length == 0) {
      return null;
    }
    int index = Math.min(Math.max(col, 0), length - 1);
    if (!isWordChar(text.charAt(index))) {
      int right = index;
      while (right < length && !isWordChar(text.charAt(right))) {
        right += 1;
      }
      if (right < length) {
        index = right;
      } else {
        int left = index;
        while (left >= 0 && !isWordChar(text.charAt(left))) {
          left -= 1;
        }
        if (left < 0) {
          return null;
        }
        index = left;
      }
    }
    int start = index;
    while (start > 0 && isWordChar(text.charAt(start - 1))) {
      start -= 1;
    }
    int end = index + 1;
    while (end < length && isWordChar(text.charAt(end))) {
      end += 1;
    }
    String word = text.substring(start, end);
    return word.isEmpty() ? null : word;
  }

  private static boolean isWordChar(char ch) {
    return Character.isLetterOrDigit(ch) || ch == '_';
  }

  private static String sanitizeUseStatements(String text) {
    String[] lines = text.split("\\r?\\n", -1);
    for (int i = 0; i < lines.length; i += 1) {
      String line = lines[i];
      if (line.matches("^\\s*use\\b.*")) {
        lines[i] = "//" + line;
      }
    }
    return String.join("\n", lines);
  }

  private static DefLocation adjustDefinitionLocation(
    DefLocation def,
    String sourceFile
  ) {
    if (def == null || def.file == null || def.file.isEmpty()) {
      return def;
    }
    if (!"class".equals(def.kind)
      && !"interface".equals(def.kind)
      && !"trait".equals(def.kind)) {
      return def;
    }

    // Resolve relative filenames against the source file's directory.
    String resolvedFile = resolveDefinitionFile(def.file, sourceFile);
    PositionMatch match = findDefinitionInFile(resolvedFile, def.kind, def.name);
    if (match == null) {
      return def;
    }
    return new DefLocation(def.kind, def.name, resolvedFile, match.line, match.col);
  }

  private static class PositionMatch {
    int line;
    int col;

    PositionMatch(int line, int col) {
      this.line = line;
      this.col = col;
    }
  }

  private static PositionMatch findDefinitionInFile(
    String filename,
    String kind,
    String name
  ) {
    try {
      String text = Files.readString(Paths.get(filename));
      String keyword = kind;
      String patternText = "(?m)\\b" + Pattern.quote(keyword) + "\\s+"
        + Pattern.quote(name) + "\\b";
      Pattern pattern = Pattern.compile(patternText);
      Matcher matcher = pattern.matcher(text);
      if (!matcher.find()) {
        return null;
      }
      int offset = matcher.start();
      return lineColFromOffset(text, offset);
    } catch (Exception e) {
      return null;
    }
  }

  private static String resolveDefinitionFile(String filename, String sourceFile) {
    File file = new File(filename);
    if (file.isAbsolute() || sourceFile == null || sourceFile.isEmpty()) {
      return filename;
    }
    File baseDir = new File(sourceFile).getParentFile();
    if (baseDir == null) {
      return filename;
    }
    return new File(baseDir, filename).getPath();
  }

  private static PositionMatch lineColFromOffset(String text, int offset) {
    int line = 1;
    int col = 1;
    for (int i = 0; i < offset && i < text.length(); i += 1) {
      char c = text.charAt(i);
      if (c == '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
    }
    return new PositionMatch(line, col);
  }

  private static Token findTokenAt(Token token, int line, int col, String sourceFile) {
    Token best = null;
    List<Token> subs = token.getSubTokens();
    for (Token sub : subs) {
      Token candidate = findTokenAt(sub, line, col, sourceFile);
      if (candidate != null) {
        best = candidate;
      }
    }

    if (best != null) {
      return best;
    }

    if (contains(token, line, col, sourceFile)) {
      return token;
    }

    return null;
  }

  private static boolean contains(Token token, int line, int col, String sourceFile) {
    if (!token.hasPosition()) {
      return false;
    }

    Position start = token.getPosition();
    Position end = token.hasEndPosition() ? token.getEndPosition() : start;
    if (start == null || end == null) {
      return false;
    }
    if (!sameFile(start.getFilename(), sourceFile)) {
      return false;
    }

    int startLine = start.getLineNumber();
    int startCol = start.getCharacterOffset();
    int endLine = end.getLineNumber();
    int endCol = end.getCharacterOffset();

    if (line < startLine || line > endLine) {
      return false;
    }
    if (line == startLine && col < startCol) {
      return false;
    }
    if (line == endLine && col > endCol) {
      return false;
    }
    return true;
  }

  private static boolean sameFile(String tokenFile, String sourceFile) {
    if (tokenFile == null || tokenFile.isEmpty() || sourceFile == null || sourceFile.isEmpty()) {
      return true;
    }
    if (tokenFile.equals(sourceFile)) {
      return true;
    }
    return new File(tokenFile).getName().equals(new File(sourceFile).getName());
  }

  private static Token findAncestor(Token token, String name) {
    Token current = token.getParentToken();
    while (current != null) {
      if (name.equals(current.getName())) {
        return current;
      }
      current = current.getParentToken();
    }
    return null;
  }

  private static String getChildValue(Token token, String childName) {
    for (Token sub : token.getSubTokens()) {
      if (childName.equals(sub.getName())) {
        return sub.getValue();
      }
    }
    return null;
  }

  private static class DefLocation {
    final String kind;
    final String name;
    final String file;
    final int line;
    final int col;

    DefLocation(String kind, String name, Position pos) {
      this.kind = kind;
      this.name = name;
      this.file = pos.getFilename() != null ? pos.getFilename() : "";
      this.line = pos.getLineNumber();
      this.col = pos.getCharacterOffset() + 1;
    }

    DefLocation(String kind, String name, String file, int line, int col) {
      this.kind = kind;
      this.name = name;
      this.file = file != null ? file : "";
      this.line = line;
      this.col = col;
    }

    String toJson() {
      return "{"
        + "\"found\":true,"
        + "\"kind\":\"" + escapeJson(kind) + "\","
        + "\"name\":\"" + escapeJson(name) + "\","
        + "\"file\":\"" + escapeJson(file) + "\","
        + "\"line\":" + line + ","
        + "\"col\":" + col
        + "}";
    }

    String toJsonWithId(int id) {
      return "{"
        + "\"id\":" + id + ","
        + "\"found\":true,"
        + "\"kind\":\"" + escapeJson(kind) + "\","
        + "\"name\":\"" + escapeJson(name) + "\","
        + "\"file\":\"" + escapeJson(file) + "\","
        + "\"line\":" + line + ","
        + "\"col\":" + col
        + "}";
    }
  }

  private static String escapeJson(String value) {
    return value
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
      .replace("\t", "\\t");
  }
}
