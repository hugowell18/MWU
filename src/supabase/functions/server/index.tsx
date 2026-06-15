import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as kv from "./kv_store.tsx";

const app = new Hono();

// Initialize Supabase Client (Service Role for Admin Actions)
// We use 'SUPABASE_SERVICE_ROLE_KEY' as provided in the environment
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Validate config
if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing Supabase configuration");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Helper to get user from token
async function getUser(c: any) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// Enable logger
app.use('*', logger(console.log));

// Enable CORS
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

// Health check
app.get("/make-server-79af63fc/health", (c) => {
  return c.json({ status: "ok" });
});

// --- Auth Routes ---

// Signup (Custom to handle auto-confirm and admin role assignment)
app.post("/make-server-79af63fc/signup", async (c) => {
  try {
    const body = await c.req.json();
    const { email, password, name } = body;
    
    if (!email || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    if (!supabaseServiceKey) {
      console.error("Server misconfiguration: Missing Service Key");
      return c.json({ error: "Server misconfiguration: Cannot create user." }, 500);
    }

    // Determine role: First user or specific email is admin
    const role = email === 'admin@ldt.com' ? 'admin' : 'user';

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: { name: name || 'User', role },
      email_confirm: true
    });

    if (error) {
      console.error("Signup error details:", error);
      return c.json({ error: error.message }, 400);
    }

    return c.json({ user: data.user, success: true });
  } catch (error: any) {
    console.error("Signup exception:", error);
    return c.json({ error: error.message || "Failed to create user" }, 500);
  }
});

// --- User Management Routes (Admin Only) ---

app.get("/make-server-79af63fc/users", async (c) => {
  const user = await getUser(c);
  
  if (!user || user.user_metadata?.role !== 'admin') {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { data: { users }, error } = await supabase.auth.admin.listUsers();
  
  if (error) {
    return c.json({ error: error.message }, 500);
  }
  
  return c.json({ users });
});

app.delete("/make-server-79af63fc/users/:id", async (c) => {
  const user = await getUser(c);
  const userIdToDelete = c.req.param("id");

  if (!user || user.user_metadata?.role !== 'admin') {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Prevent self-deletion
  if (user.id === userIdToDelete) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }

  const { error } = await supabase.auth.admin.deleteUser(userIdToDelete);

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ success: true });
});

// --- Community Routes ---

app.get("/make-server-79af63fc/posts", async (c) => {
  try {
    const posts = await kv.getByPrefix("ldt_post:");
    return c.json(posts);
  } catch (error) {
    console.log("Error fetching posts:", error);
    return c.json({ error: "Failed to fetch posts" }, 500);
  }
});

app.post("/make-server-79af63fc/posts", async (c) => {
  try {
    const user = await getUser(c);
    if (!user) {
      // If auth token is invalid or missing
      return c.json({ error: "Unauthorized" }, 401);
    }

    const postData = await c.req.json();
    if (!postData.title || !postData.content) {
      return c.json({ error: "Title and content required" }, 400);
    }

    const newPost = {
      ...postData,
      id: postData.id || `post-${Date.now()}`,
      author: user.user_metadata.name || 'Anonymous',
      authorId: user.id, 
      timestamp: Date.now(),
      likes: 0,
      replies: 0,
      likedBy: [] // Track users who liked
    };

    await kv.set(`ldt_post:${newPost.id}`, newPost);
    return c.json({ success: true, post: newPost });
  } catch (error) {
    console.log("Error saving post:", error);
    return c.json({ error: "Failed to save post" }, 500);
  }
});

app.post("/make-server-79af63fc/posts/:id/like", async (c) => {
  try {
    const user = await getUser(c);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const postId = c.req.param("id");
    const post = await kv.get(`ldt_post:${postId}`);

    if (!post) {
      return c.json({ error: "Post not found" }, 404);
    }

    // Check if user already liked
    const likedBy = post.likedBy || [];
    const userId = user.id;

    if (likedBy.includes(userId)) {
      // Unlike
      const index = likedBy.indexOf(userId);
      likedBy.splice(index, 1);
      post.likes = Math.max(0, post.likes - 1);
    } else {
      // Like
      likedBy.push(userId);
      post.likes = (post.likes || 0) + 1;
    }

    post.likedBy = likedBy;
    await kv.set(`ldt_post:${postId}`, post);

    return c.json({ success: true, likes: post.likes, likedBy });
  } catch (error) {
    console.log("Error processing like:", error);
    return c.json({ error: "Failed to process like" }, 500);
  }
});

app.delete("/make-server-79af63fc/posts/:id", async (c) => {
  const user = await getUser(c);
  const postId = c.req.param("id");

  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const post = await kv.get(`ldt_post:${postId}`);
    if (!post) {
      return c.json({ error: "Post not found" }, 404);
    }

    // Check permissions: Admin or Author
    const isAdmin = user.user_metadata?.role === 'admin';
    const isAuthor = post.authorId === user.id;

    if (!isAdmin && !isAuthor) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await kv.del(`ldt_post:${postId}`);
    return c.json({ success: true });

  } catch (error) {
    return c.json({ error: "Failed to delete post" }, 500);
  }
});

Deno.serve(app.fetch);
