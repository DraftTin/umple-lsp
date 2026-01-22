import cruise.umple.compiler.Attribute;
import cruise.umple.compiler.UmpleClass;
import cruise.umple.compiler.UmpleFile;
import cruise.umple.compiler.UmpleInternalParser;
import cruise.umple.compiler.UmpleModel;
import cruise.umple.parser.ParseResult;
import cruise.umple.parser.Position;
import cruise.umple.parser.Token;
import java.io.File;
import java.util.List;

public class UmpleGoToDefJson {
  public static void main(String[] args) throws Exception {
    if (args.length < 3) {
      System.out.println("{\"found\":false}");
      return;
    }

    String filename = args[0];
    int line = Integer.parseInt(args[1]);
    int col = Integer.parseInt(args[2]);

    UmpleFile umpleFile = new UmpleFile(filename);
    UmpleModel model = new UmpleModel(umpleFile);

    UmpleInternalParser parser = new UmpleInternalParser();
    parser.setModel(model);
    parser.setFilename(filename);
    File inputFile = new File(filename);
    if (!inputFile.isFile()) {
      System.out.println("{\"found\":false}");
      return;
    }
    ParseResult result = parser.getParser().parse(inputFile);
    parser.setParseResult(result);
    parser.setRootToken(parser.getParser().getRootToken());
    parser.analyze(false);

    Token root = parser.getRootToken();
    Token token = findTokenAt(root, line, col, filename);
    if (token == null) {
      System.out.println("{\"found\":false}");
      return;
    }

    DefLocation def = resolveDefinition(token, model, filename);
    if (def == null) {
      System.out.println("{\"found\":false}");
      return;
    }

    System.out.println(def.toJson());
  }

  private static DefLocation resolveDefinition(Token token, UmpleModel model, String sourceFile) {
    String value = token.getValue();
    if (value == null || value.isEmpty()) {
      return null;
    }

    DefLocation useDef = resolveUseDefinition(token, value, sourceFile);
    if (useDef != null) {
      return useDef;
    }

    Token classDef = findAncestor(token, "classDefinition");
    String className = classDef != null ? getChildValue(classDef, "name") : null;
    if (className != null) {
      UmpleClass cls = model.getUmpleClass(className);
      if (cls != null) {
        Attribute attr = cls.getAttribute(value);
        if (attr != null && attr.hasPosition()) {
          Position pos = attr.getPosition();
          return new DefLocation("attribute", value, pos);
        }
      }
    }
    UmpleClass cls = model.getUmpleClass(value);
    if (cls != null && cls.hasPosition()) {
      Position pos = cls.getPosition(0);
      return new DefLocation("class", value, pos);
    }

    return null;
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

  private static DefLocation resolveUseDefinition(Token token, String value, String sourceFile) {
    if (!value.endsWith(".ump")) {
      return null;
    }
    if (!isUseContext(token)) {
      return null;
    }

    File source = new File(sourceFile);
    File baseDir = source.getParentFile();
    File targetFile = baseDir != null ? new File(baseDir, value) : new File(value);
    String resolved = targetFile.getPath();
    return new DefLocation("use", value, resolved, 1, 1);
  }

  private static boolean isUseContext(Token token) {
    Token current = token;
    while (current != null) {
      String name = current.getName();
      if (name != null && name.toLowerCase().contains("use")) {
        return true;
      }
      current = current.getParentToken();
    }
    return false;
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
