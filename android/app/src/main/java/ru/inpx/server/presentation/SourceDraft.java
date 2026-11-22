package ru.inpx.server.presentation;

/** Editable source, passed only to the source form and repository, never to dashboard rendering. */
public final class SourceDraft {
  public final String id, kind, name, uri, host, share, folder, user, password, domain;

  public SourceDraft(
      String id,
      String kind,
      String name,
      String uri,
      String host,
      String share,
      String folder,
      String user,
      String password,
      String domain) {
    this.id = id;
    this.kind = kind;
    this.name = name;
    this.uri = uri;
    this.host = host;
    this.share = share;
    this.folder = folder;
    this.user = user;
    this.password = password;
    this.domain = domain;
  }

  public static SourceDraft tree(String id, String name, String uri) {
    return new SourceDraft(id, "tree", name, uri, "", "", "", "", "", "");
  }

  public SourceDraft renamed(String title) {
    return new SourceDraft(id, kind, title, uri, host, share, folder, user, password, domain);
  }
}
